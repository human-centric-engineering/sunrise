/**
 * Tests for the Prisma schema format check.
 *
 * These run against a **real temp directory and the real formatter** rather
 * than mocks. The whole point of the script is that `prisma format` and the
 * filesystem behave a particular way — a mocked `execFileSync` would assert
 * only that this file's author believed they do.
 *
 * @see scripts/ci/check-prisma-format.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  checkPrismaFormat,
  describeError,
  findUnformatted,
  listSchemaFiles,
} from '@/scripts/ci/check-prisma-format';

/**
 * A minimal but valid multi-file schema: datasource, generator, one model.
 *
 * No `url` in the datasource — Prisma 7 removed it from schema files entirely
 * (connection URLs live in `prisma.config.ts`), and leaving it in fails
 * validation before the formatter ever runs.
 */
const BASE_SCHEMA = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}
`;

const TIDY_MODEL = `model Widget {
  id   String @id
  name String
}
`;

/** The same model with the alignment the formatter would rewrite. */
const UNTIDY_MODEL = `model Widget {
  id String @id
  name    String
}
`;

describe('scripts/ci/check-prisma-format', () => {
  let dir: string;
  let originalExitCode: typeof process.exitCode;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunrise-prisma-fmt-test-'));
    writeFileSync(join(dir, 'base.prisma'), BASE_SCHEMA);
    // Importing the module runs the check against the real `prisma/schema` and
    // assigns `process.exitCode`. Restore it, or a genuinely misformatted
    // schema in this repo would fail the whole vitest run from an import.
    originalExitCode = process.exitCode;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  describe('describeError', () => {
    it('uses the message of a real Error', () => {
      expect(describeError(new Error('boom'))).toBe('boom');
    });

    it('stringifies anything else rather than printing undefined', () => {
      expect(describeError('boom')).toBe('boom');
    });
  });

  describe('listSchemaFiles', () => {
    it('returns only .prisma files, sorted', () => {
      writeFileSync(join(dir, 'z.prisma'), TIDY_MODEL);
      writeFileSync(join(dir, 'a.prisma'), '');
      writeFileSync(join(dir, 'notes.md'), '# not a schema');

      expect(listSchemaFiles(dir)).toEqual(['a.prisma', 'base.prisma', 'z.prisma']);
    });
  });

  describe('findUnformatted', () => {
    it('reports nothing for an already-formatted schema', () => {
      writeFileSync(join(dir, 'widget.prisma'), TIDY_MODEL);

      expect(findUnformatted(dir)).toEqual([]);
    });

    it('names the file the formatter would rewrite', () => {
      writeFileSync(join(dir, 'widget.prisma'), UNTIDY_MODEL);

      expect(findUnformatted(dir)).toEqual(['widget.prisma']);
    });

    it('names every offending file, not just the first', () => {
      writeFileSync(join(dir, 'a-widget.prisma'), UNTIDY_MODEL);
      writeFileSync(join(dir, 'b-gadget.prisma'), UNTIDY_MODEL.replace(/Widget/g, 'Gadget'));

      expect(findUnformatted(dir)).toEqual(['a-widget.prisma', 'b-gadget.prisma']);
    });

    it('does not modify the files it checks', () => {
      // The reason this check can live in `npm run validate` at all. A mutating
      // check in a chain people run mid-edit would rewrite work in progress.
      writeFileSync(join(dir, 'widget.prisma'), UNTIDY_MODEL);

      findUnformatted(dir);

      expect(readFileSync(join(dir, 'widget.prisma'), 'utf8')).toBe(UNTIDY_MODEL);
    });

    it('ignores uncommitted edits, which the git-diff form could not', () => {
      // The check CI used — `prisma format && git diff --exit-code` — is right
      // only on a clean tree. Locally it reports your own well-formatted
      // work-in-progress as drift, which is precisely the person #510 is for.
      // Proven here against real git rather than argued.
      execFileSync('git', ['init', '--quiet'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
      writeFileSync(join(dir, 'widget.prisma'), TIDY_MODEL);
      execFileSync('git', ['add', '-A'], { cwd: dir });
      execFileSync('git', ['commit', '--quiet', '-m', 'initial'], { cwd: dir });

      // A new, correctly-formatted, uncommitted model.
      writeFileSync(
        join(dir, 'widget.prisma'),
        `${TIDY_MODEL}\nmodel Gizmo {\n  id String @id\n}\n`
      );

      expect(findUnformatted(dir)).toEqual([]);

      // …while the git-based form calls the same tree dirty.
      execFileSync('npx', ['prisma', 'format', '--schema', dir], { stdio: 'ignore' });
      let gitSaysDirty = false;
      try {
        execFileSync('git', ['diff', '--exit-code'], { cwd: dir, stdio: 'ignore' });
      } catch {
        gitSaysDirty = true;
      }
      expect(gitSaysDirty).toBe(true);
    });

    it('surfaces a schema the formatter cannot parse rather than passing it', () => {
      // `prisma format` exits non-zero on a syntax error. Swallowing that would
      // turn a broken schema into a silent pass.
      writeFileSync(join(dir, 'widget.prisma'), 'model Widget { id String @id');

      expect(() => findUnformatted(dir)).toThrow();
    });
  });

  describe('checkPrismaFormat', () => {
    /** Captures stderr/stdout so the operator-facing output can be asserted. */
    function capture(): { out: () => string } {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      return {
        out: () => [...err.mock.calls, ...log.mock.calls].map((call) => String(call[0])).join('\n'),
      };
    }

    it('exits 0 and says how many files it read', () => {
      writeFileSync(join(dir, 'widget.prisma'), TIDY_MODEL);
      const { out } = capture();

      expect(checkPrismaFormat(dir)).toBe(0);
      expect(out()).toContain('prisma/schema OK (2 files).');
    });

    it('exits 1, names each file, and says how to fix it', () => {
      writeFileSync(join(dir, 'widget.prisma'), UNTIDY_MODEL);
      const { out } = capture();

      expect(checkPrismaFormat(dir)).toBe(1);
      expect(out()).toContain('1 schema file not formatted');
      expect(out()).toContain('prisma/schema/widget.prisma');
      expect(out()).toContain("Run 'npm run format:prisma'");
      // The fork case is the one most likely to hit this and least likely to
      // guess why, so the message has to name it.
      expect(out()).toContain('framework-*.prisma / app.prisma');
    });

    it('pluralizes when more than one file is wrong', () => {
      writeFileSync(join(dir, 'a-widget.prisma'), UNTIDY_MODEL);
      writeFileSync(join(dir, 'b-gadget.prisma'), UNTIDY_MODEL.replace(/Widget/g, 'Gadget'));
      const { out } = capture();

      expect(checkPrismaFormat(dir)).toBe(1);
      expect(out()).toContain('2 schema files not formatted');
    });

    it('exits 1 with the reason when the schema cannot be parsed', () => {
      // Not a silent pass, and not a raw stack trace out of the first link in
      // `npm run validate`.
      writeFileSync(join(dir, 'widget.prisma'), 'model Widget { id String @id');
      const { out } = capture();

      expect(checkPrismaFormat(dir)).toBe(1);
      expect(out()).toContain('Could not check');
    });

    it('exits 1 when the directory does not exist', () => {
      const { out } = capture();

      expect(checkPrismaFormat(join(dir, 'nope'))).toBe(1);
      expect(out()).toContain('Could not check');
    });
  });
});
