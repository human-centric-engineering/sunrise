/**
 * Tests for the Prisma schema format check.
 *
 * These run against a **real temp directory and the real formatter** rather
 * than mocks. The whole point of the script is that `prisma format` and the
 * filesystem behave a particular way — a mocked `execFileSync` would assert
 * only that this file's author believed they do.
 *
 * @see scripts/ci/prisma-format.ts
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  checkPrismaFormat,
  describeError,
  findUnformatted,
  listSchemaFiles,
  prismaBin,
  prismaSpawnOptions,
  rewriteScratchPaths,
} from '@/scripts/ci/prisma-format';

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

describe('scripts/ci/prisma-format', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunrise-schema-test-'));
    writeFileSync(join(dir, 'base.prisma'), BASE_SCHEMA);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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

  describe('prismaBin', () => {
    it('uses the local POSIX bin, unquoted', () => {
      // Unquoted because there is no shell to split it; quoting here would
      // become part of the filename.
      expect(prismaBin('darwin', '/repo')).toBe('prisma');
      expect(prismaBin('darwin', process.cwd())).toBe(
        join(process.cwd(), 'node_modules', '.bin', 'prisma')
      );
    });

    it('uses the .cmd shim, quoted, on Windows', () => {
      // Node refuses to spawn a .cmd without a shell (CVE-2024-27980), so the
      // call passes `shell: true` there — and a shell splits on the spaces a
      // Windows checkout path contains, hence the quotes. Same reasoning as
      // `resolveBin` in scripts/dev-server.mjs.
      //
      // The shim has to EXIST for the name to matter: with no local install
      // both platforms fall back to the bare `prisma`, so asserting against a
      // nonexistent root would pass with the `.cmd` branch deleted.
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', 'prisma.cmd'), '');

      expect(prismaBin('win32', dir)).toBe(`"${join(dir, 'node_modules', '.bin', 'prisma.cmd')}"`);
    });

    it('falls back to the bare name when no local bin is installed', () => {
      expect(prismaBin('linux', '/definitely/not/a/repo')).toBe('prisma');
    });
  });

  describe('prismaSpawnOptions', () => {
    it.each([
      ['win32', true],
      ['darwin', false],
      ['linux', false],
    ])('uses shell=%s on %s only where the bin needs one', (platform, expected) => {
      expect(prismaSpawnOptions(platform as NodeJS.Platform).shell).toBe(expected);
    });

    it('agrees with the binary prismaBin hands back', () => {
      // The invariant, stated once: a `.cmd` requires a shell, anything else
      // must not have one. Asserted together so neither can drift alone.
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', 'prisma.cmd'), '');

      for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
        const bin = prismaBin(platform, dir);
        expect(prismaSpawnOptions(platform).shell).toBe(bin.includes('.cmd'));
      }
    });
  });

  describe('nested schema files', () => {
    // `prisma format` recurses — verified against the pinned 7.9.1. A flat
    // listing was wrong in both directions for a fork that organises its
    // schema into folders.
    it('checks a schema file in a subdirectory', () => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'widget.prisma'), UNTIDY_MODEL);

      expect(findUnformatted(dir)).toEqual([join('sub', 'widget.prisma')]);
    });

    it('passes a correctly-formatted nested file rather than skipping it', () => {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'widget.prisma'), TIDY_MODEL);

      expect(findUnformatted(dir)).toEqual([]);
    });

    it('copies enough of the tree for a cross-directory relation to resolve', () => {
      // The second failure mode: with the nested file missing from the copy,
      // `prisma format` fails P1012 on an incomplete schema and the check
      // reports a broken schema when the schema is fine.
      mkdirSync(join(dir, 'sub'));
      writeFileSync(
        join(dir, 'owner.prisma'),
        'model Owner {\n  id      String   @id\n  widgets Widget[]\n}\n'
      );
      writeFileSync(
        join(dir, 'sub', 'widget.prisma'),
        'model Widget {\n  id      String @id\n  ownerId String\n  owner   Owner  @relation(fields: [ownerId], references: [id])\n}\n'
      );

      expect(findUnformatted(dir)).toEqual([]);
    });
  });

  describe('rewriteScratchPaths', () => {
    it('points a formatter message back at the real schema', () => {
      const message = 'error at /tmp/sunrise-prisma-fmt-abc/widget.prisma:3';

      expect(rewriteScratchPaths(message, '/tmp/sunrise-prisma-fmt-abc', 'prisma/schema')).toBe(
        'error at prisma/schema/widget.prisma:3'
      );
    });

    it('rewrites every occurrence, not just the first', () => {
      // Prisma names the directory once and the offending file again below it.
      const message = '/tmp/scratch-abc loaded\n  --> /tmp/scratch-abc/widget.prisma:3';

      expect(rewriteScratchPaths(message, '/tmp/scratch-abc', 'prisma/schema')).toBe(
        'prisma/schema loaded\n  --> prisma/schema/widget.prisma:3'
      );
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
      // Names the directory it was ACTUALLY given, not the module constant.
      expect(out()).toContain(`${dir} OK (2 files).`);
    });

    it('exits 1, names each file, and says how to fix it', () => {
      writeFileSync(join(dir, 'widget.prisma'), UNTIDY_MODEL);
      const { out } = capture();

      expect(checkPrismaFormat(dir)).toBe(1);
      expect(out()).toContain('1 schema file not formatted');
      expect(out()).toContain(join(dir, 'widget.prisma'));
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
      // And it names a file that still exists. Prisma reports against the
      // copy, which the `finally` deletes before this prints, so the operator
      // was being handed a path to nothing for the one failure this script
      // most needs to make legible.
      expect(out()).toContain(join(dir, 'widget.prisma'));
      // The scratch prefix, which this test's own dir deliberately does not
      // share — an assertion that matched its own fixture would prove nothing.
      expect(out()).not.toContain('sunrise-prisma-fmt-');
    });

    it('exits 1 when the directory does not exist', () => {
      const { out } = capture();

      expect(checkPrismaFormat(join(dir, 'nope'))).toBe(1);
      expect(out()).toContain('Could not check');
    });
  });
});
