/**
 * Tests: no bare role literal outside `lib/auth/roles.ts`
 *
 * `User.role` is a free-form `String` on the schema, and its two values used to
 * be written out as literals in 37 places — route handlers, client components,
 * Zod schemas, seeds and smoke scripts. A fork adding a third value had no
 * canonical list and no way to find every site but a string hunt (#366 item 3).
 *
 * The sweep that fixed that is only worth as much as this guard: a hand-swept
 * roster re-drifts the moment one PR writes `role === 'ADMIN'` again, and
 * nothing else in the suite would notice. This is the
 * `tests/unit/db-raw-sql-allowlist.test.ts` shape — scan the tree, compare
 * against an allowlist of sites that are deliberately exempt, fail on anything
 * new.
 *
 * **The pattern is derived from `USER_ROLES`, not hardcoded.** Add a role to
 * that constant and this guard starts policing its literal too, with no edit
 * here. A guard that enumerates what it looks for goes stale exactly as fast as
 * the list it is protecting — a lesson this repo learned twice over in #732,
 * where every boundary of a derived-roster guard had to be inverted from an
 * allowlist to an exclusion rule.
 *
 * ## What is deliberately not scanned
 *
 * **Tests.** A fixture saying `role: 'ADMIN'` is describing data, not encoding
 * the vocabulary, and requiring every fixture to import the constant would add
 * ceremony to hundreds of files to protect nothing — the drift this guard
 * exists to stop is in code that makes decisions, not in code that makes rows.
 *
 * **`lib/auth/roles.ts` itself**, which is where the literals are supposed to
 * live.
 *
 * A green run therefore means "no source file outside the module writes a role
 * literal", never "the vocabulary is used correctly everywhere".
 *
 * @see lib/auth/roles.ts · scripts/ci/scoped-tests.ts (ALWAYS_RUN_TESTS)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { USER_ROLES } from '@/lib/auth/roles';

/** Source trees whose role handling is the platform's own. */
const SCANNED = ['app', 'components', 'lib', 'types', 'prisma', 'scripts'];

/** The module that owns the vocabulary — the one place a literal belongs. */
const OWNER = path.join('lib', 'auth', 'roles.ts');

/**
 * Sites allowed to write a bare role literal, each with the reason.
 *
 * Empty, and that is the state to keep it in. A row here is a claim that the
 * constant genuinely cannot be used at that site — not that using it was
 * inconvenient. If you add one, say why in the comment beside it, because the
 * next person's only alternative is to re-derive your reasoning from the diff.
 */
const ALLOWED = new Set<string>([]);

/** Files this guard reads: tracked TypeScript sources, minus tests and the owner. */
function scannedFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', ...SCANNED], { encoding: 'utf8' });
  return tracked
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
    .filter((f) => f !== OWNER.split(path.sep).join('/'))
    .sort();
}

/**
 * Every role value as a quoted literal, built from the constant itself.
 *
 * Single and double quotes both, because JSX attributes take double quotes and
 * a scan that only knew about single ones would have missed
 * `<SelectItem value="ADMIN">` — which was a real site in the sweep.
 */
const ROLE_LITERAL = new RegExp(`['"](${USER_ROLES.join('|')})['"]`);

/**
 * Strip comments, crudely but predictably.
 *
 * A docblock quoting `role === 'ADMIN'` while explaining the rule is not drift,
 * and there are several. This drops `//` lines and `/* … *\/` blocks; it does
 * not understand a comment marker inside a string literal, which would cause a
 * false NEGATIVE rather than a false positive — the safe direction for a line
 * that is genuinely code.
 */
function stripComments(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false;
      out.push('');
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true;
      out.push('');
      continue;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out;
}

/** Every `file:line` writing a role literal, outside the allowlist. */
function roleLiteralSites(): string[] {
  const found: string[] = [];
  for (const file of scannedFiles()) {
    const lines = stripComments(readFileSync(path.join(process.cwd(), file), 'utf8'));
    lines.forEach((line, i) => {
      if (!ROLE_LITERAL.test(line)) return;
      const site = `${file}:${i + 1}`;
      if (!ALLOWED.has(site)) found.push(`${site}  ${line.trim().slice(0, 90)}`);
    });
  }
  return found;
}

describe('role literals live in lib/auth/roles.ts', () => {
  it('no source file outside the module writes one', () => {
    expect(
      roleLiteralSites(),
      'These sites write a role value as a literal instead of reading it from ' +
        '`lib/auth/roles.ts`. That is the drift #366 asked us to remove: with the ' +
        'vocabulary spelled out in many places, adding a role means finding them ' +
        'all by hand. Import `USER_ROLES` / `PLATFORM_ADMIN_ROLE` / ' +
        '`isPlatformAdmin()`, or — if the constant genuinely cannot be used here ' +
        '— add the site to ALLOWED above with the reason.'
    ).toEqual([]);
  });

  it('scans a tree it can actually see', () => {
    // Guards the scanner, not the code. `git ls-files` returning nothing — a
    // renamed directory, a detached checkout, a cwd that is not the repo root —
    // would make the assertion above pass while reading no files at all, which
    // is the quiet green this whole file exists to prevent.
    expect(scannedFiles().length).toBeGreaterThan(100);
  });

  it('builds its pattern from the constant, so a new role is policed too', () => {
    // The property, not the current values: if USER_ROLES gains 'MODERATOR',
    // the scan must look for it without anyone editing this file.
    for (const role of USER_ROLES) {
      expect(ROLE_LITERAL.test(`const x = '${role}';`), `single-quoted ${role}`).toBe(true);
      expect(ROLE_LITERAL.test(`<Item value="${role}" />`), `double-quoted ${role}`).toBe(true);
    }
    expect(ROLE_LITERAL.test("const x = 'NOT_A_ROLE';")).toBe(false);
  });
});
