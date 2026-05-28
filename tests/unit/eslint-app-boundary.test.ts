/**
 * Tests: ESLint lib/app/** boundary rule (fork-readiness seam 5)
 *
 * The `lib/app/**` override in `eslint.config.mjs` must:
 *   - ban RUNTIME `next/*` imports while ALLOWING type-only imports, and
 *   - restate the @/-alias relative-import ban (flat-config
 *     `no-restricted-imports` REPLACES rather than merges, so dropping this
 *     would silently disable alias enforcement on lib/app files).
 *
 * To verify BEHAVIOUR (not just configuration shape), we pull the REAL rule
 * entry out of the project's flat config and run it through ESLint's `Linter`
 * against fixture source. Only the parser/plugin harness is reconstructed; the
 * rule options under test come straight from the shipped config — so a
 * regression in the actual file fails this test.
 *
 * @see eslint.config.mjs
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

const APP_BOUNDARY_FILES = 'lib/app/**/*.{ts,tsx}';

interface FlatConfigBlock {
  files?: string[];
  rules?: Record<string, unknown>;
}

let appBoundaryRule: Linter.RuleEntry;

beforeAll(async () => {
  const mod = (await import('@/eslint.config.mjs')) as { default: FlatConfigBlock[] };
  const block = mod.default.find(
    (c) => Array.isArray(c.files) && c.files.includes(APP_BOUNDARY_FILES)
  );
  if (!block) throw new Error(`No flat-config block targeting "${APP_BOUNDARY_FILES}" found`);

  // Assign unconditionally — if block is missing the throw above fires.
  // Structural expectations have been moved to a dedicated it() below so
  // a misconfigured block fails that test explicitly rather than silently
  // disabling appBoundaryRule for sibling tests.
  appBoundaryRule = block.rules?.['@typescript-eslint/no-restricted-imports'] as Linter.RuleEntry;
});

/** Lint a snippet as if it were a file under lib/app/, using the real rule. */
function lint(code: string): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { '@typescript-eslint': tseslint.plugin },
        rules: { '@typescript-eslint/no-restricted-imports': appBoundaryRule },
      },
    ],
    'lib/app/example.ts'
  );
}

describe('lib/app/** import boundary (seam 5)', () => {
  // Finding 5: structural assertions extracted from beforeAll so a missing/
  // misconfigured block fails THIS test explicitly rather than silently
  // leaving appBoundaryRule undefined and letting toHaveLength(0) tests
  // false-pass.
  it('lib/app boundary block is wired correctly (base rule off, TS variant present)', async () => {
    // Arrange
    const mod = (await import('@/eslint.config.mjs')) as { default: FlatConfigBlock[] };
    const block = mod.default.find(
      (c) => Array.isArray(c.files) && c.files.includes(APP_BOUNDARY_FILES)
    );

    // Assert: block must exist (if not, beforeAll would have thrown already)
    expect(block).toBeDefined();

    // The base rule MUST be off for these files, otherwise it double-reports the
    // relative-import patterns alongside the @typescript-eslint variant.
    expect(block?.rules?.['no-restricted-imports']).toBe('off');

    // The TS variant must be present and non-trivially configured.
    expect(block?.rules?.['@typescript-eslint/no-restricted-imports']).toBeDefined();
  });

  it('flags a runtime next/* import', () => {
    const msgs = lint(
      "import { NextResponse } from 'next/server';\nexport const x = NextResponse;"
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].ruleId).toBe('@typescript-eslint/no-restricted-imports');
    expect(msgs[0].message).toMatch(/framework-agnostic/i);
  });

  it('allows a type-only next/* import (allowTypeImports)', () => {
    const msgs = lint(
      "import type { NextRequest } from 'next/server';\nexport type Handler = (r: NextRequest) => void;"
    );
    expect(msgs).toHaveLength(0);
  });

  it('flags a relative sibling import — the @/-alias ban is restated', () => {
    const msgs = lint("import { foo } from './sibling';\nexport const x = foo;");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/@\/ path alias/);
  });

  it('flags a relative parent import', () => {
    // Finding 3: tightened from weak .some() predicate to mirror the sibling-
    // import assertion: exact message count, ruleId, and message content.
    const msgs = lint("import { foo } from '../util';\nexport const x = foo;");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].ruleId).toBe('@typescript-eslint/no-restricted-imports');
    expect(msgs[0].message).toMatch(/@\/ path alias/);
  });

  it('allows an @/ alias import', () => {
    const msgs = lint("import { logger } from '@/lib/logging';\nexport const x = logger;");
    expect(msgs).toHaveLength(0);
  });

  it('allows a bare third-party import (e.g. zod)', () => {
    const msgs = lint("import { z } from 'zod';\nexport const s = z.object({});");
    expect(msgs).toHaveLength(0);
  });

  // ── Expanded patterns (finding #7) ──────────────────────────────────────
  // The boundary covers more than `next/*`: react-dom, prisma, Node-only
  // built-ins, and the `next/dist/**` deep-import escape hatch all need to
  // be flagged. Otherwise a fork could land code in lib/app/ that crashes
  // at runtime (Node built-ins in the edge/client realm) or pulls server-
  // only modules into the client bundle (prisma, react-dom).

  it('flags a deep next/dist/** import (does NOT slip past the next/* glob)', () => {
    // `next/*` doesn't cross `/`, so `next/dist/server/...` would slip
    // through without the explicit `next/dist/**` entry.
    const msgs = lint(
      "import { something } from 'next/dist/server/web/spec-extension/response';\nexport const x = something;"
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/framework-agnostic/i);
  });

  it('flags a bare react-dom import', () => {
    const msgs = lint(
      "import { hydrateRoot } from 'react-dom/client';\nexport const x = hydrateRoot;"
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/react-dom/);
  });

  it('flags react-dom/server (would land in client bundle on hydration)', () => {
    const msgs = lint(
      "import { renderToString } from 'react-dom/server';\nexport const x = renderToString;"
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/react-dom/);
  });

  it('allows a type-only react-dom import (allowTypeImports preserved)', () => {
    const msgs = lint("import type { Root } from 'react-dom/client';\nexport type R = Root;");
    expect(msgs).toHaveLength(0);
  });

  it('flags a bare prisma import', () => {
    const msgs = lint("import { PrismaClient } from 'prisma';\nexport const x = PrismaClient;");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/Prisma/);
  });

  it('flags an @prisma/client import', () => {
    const msgs = lint(
      "import { PrismaClient } from '@prisma/client';\nexport const x = PrismaClient;"
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/Prisma/);
  });

  it('allows a type-only Prisma import (allowTypeImports preserved)', () => {
    const msgs = lint("import type { User } from '@prisma/client';\nexport type U = User;");
    expect(msgs).toHaveLength(0);
  });

  it('flags a bare Node fs import', () => {
    const msgs = lint("import { readFile } from 'fs';\nexport const x = readFile;");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/Node-only/i);
  });

  it("flags a 'node:' specifier (Node 16+ explicit form)", () => {
    const msgs = lint("import { readFile } from 'node:fs/promises';\nexport const x = readFile;");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/Node-only/i);
  });

  it("flags the bare 'path' built-in", () => {
    const msgs = lint("import { join } from 'path';\nexport const x = join;");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message).toMatch(/Node-only/i);
  });
});
