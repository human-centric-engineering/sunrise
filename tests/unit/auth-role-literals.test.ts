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
 * Everything else git tracks IS scanned, `proxy.ts` and `instrumentation.ts`
 * included. Those two sit outside every source directory, and an earlier
 * version of this guard listed directories to visit rather than exclusions —
 * so a role gate in Next 16's middleware, the likeliest place for one, would
 * have left it green.
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

/** The module that owns the vocabulary — the one place a literal belongs. */
const OWNER = 'lib/auth/roles.ts';

/**
 * Paths this guard does not read.
 *
 * A deny-list over **everything git tracks**, rather than a list of source
 * trees to visit. The first version named six directories — `app`,
 * `components`, `lib`, `types`, `prisma`, `scripts` — which left `proxy.ts`
 * unscanned. That file is Next 16's middleware and the single most likely home
 * for a route-level role gate, and `emails/`, `hooks/` and
 * `instrumentation.ts` were outside it too. A guard that enumerates where to
 * look has the same failure mode as the hand-maintained list it replaces: it is
 * complete only until someone adds a directory.
 */
const NOT_SCANNED = [
  /^tests\//, //        fixtures describe data, not vocabulary — see the header
  new RegExp(`^${OWNER}$`), // the module that owns the literals
];

/**
 * Sites allowed to write a bare role literal, each with the reason.
 *
 * Empty, and that is the state to keep it in. A row here is a claim that the
 * constant genuinely cannot be used at that site — not that using it was
 * inconvenient. If you add one, say why in the comment beside it, because the
 * next person's only alternative is to re-derive your reasoning from the diff.
 */
const ALLOWED = new Set<string>([]);

/** Files this guard reads: every tracked TypeScript source but the exclusions. */
function scannedFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' });
  return tracked
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !/\.(test|spec)\.tsx?$/.test(f))
    .filter((f) => !NOT_SCANNED.some((rx) => rx.test(f)))
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
 * Strip comments, tracking string state so a `//` inside a literal is not
 * mistaken for one.
 *
 * A docblock quoting `role === 'ADMIN'` while explaining the rule is not drift,
 * and there are several. The first version of this only blanked lines whose
 * *trimmed* form began with a comment marker, which left **trailing** comments
 * intact — so `const isAdmin = check(u); // formerly role === 'ADMIN'` was
 * scanned as code and failed the guard. That is a false POSITIVE, and this
 * guard is in `ALWAYS_RUN_TESTS`: it would have broken CI on a comment, with a
 * message telling the author to import a constant into it. The docblock at the
 * time claimed the crude version could only err towards false negatives, "the
 * safe direction" — it could not, and the claim is what made the gap easy to
 * miss.
 *
 * Quote tracking is what makes cutting at `//` safe: without it, a line
 * containing `'https://example.com'` would be truncated at the scheme and any
 * role literal after it silently dropped.
 *
 * **Template literals are prose; their `${…}` interpolations are code.** A
 * prompt template in `lib/orchestration/` may legitimately say "answer with
 * 'USER' or 'ADMIN'", and flagging that is a red build over a string. But
 * `${user.role === 'ADMIN' ? …}` inside the same template is a real
 * comparison, so interpolation depth is tracked and its contents are scanned.
 * Template state carries across lines, because a backtick string is the only
 * one that may span them.
 *
 * `'` and `\"` reset per line instead — they cannot span a line in valid
 * source, and resetting contains the damage from an apostrophe in prose: a
 * stray quote cannot leave the scanner in string state for the rest of a file.
 *
 * Two earlier versions got this wrong in the same direction, each introduced by
 * the fix for the one before: the first ignored trailing comments, the second
 * reset template state per line and flagged line 2 of a prompt.
 */
function stripComments(source: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  let inTemplate = false;
  let interpolationDepth = 0;

  for (const line of source.split('\n')) {
    let code = '';
    let quote: string | null = null;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];

      if (inBlock) {
        if (ch === '*' && next === '/') {
          inBlock = false;
          i++;
        }
        continue;
      }

      // Template literal, outside `${}`: prose, not code.
      if (inTemplate && interpolationDepth === 0) {
        if (ch === '\\') i++;
        else if (ch === '`') inTemplate = false;
        else if (ch === '$' && next === '{') {
          interpolationDepth = 1;
          i++;
        }
        continue;
      }

      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        code += ch;
        continue;
      }

      if (interpolationDepth > 0) {
        if (ch === '{') interpolationDepth++;
        else if (ch === '}') interpolationDepth--;
      }

      if (ch === '`') {
        inTemplate = true;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        code += ch;
        continue;
      }
      if (ch === '/' && next === '/') break;
      if (ch === '/' && next === '*') {
        inBlock = true;
        i++;
        continue;
      }
      code += ch;
    }

    out.push(code.trim().startsWith('*') ? '' : code);
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

describe('comment stripping', () => {
  /** What the scanner would flag on one line of source. */
  const flags = (line: string) => stripComments(line).some((l) => ROLE_LITERAL.test(l));

  it('ignores a role literal in a trailing comment', () => {
    // The false positive the first version shipped. This guard is in
    // ALWAYS_RUN_TESTS, so getting it wrong breaks CI on a comment.
    expect(flags("const isAdmin = check(u); // formerly role === 'ADMIN'")).toBe(false);
  });

  it('ignores a whole-line and a block comment', () => {
    expect(flags("// role === 'ADMIN'")).toBe(false);
    expect(flags("/* role === 'ADMIN' */")).toBe(false);
    expect(flags(" * role === 'ADMIN'")).toBe(false);
  });

  it('still flags a role literal in real code', () => {
    // The other direction: stripping must not swallow the thing being guarded.
    expect(flags("if (user.role === 'ADMIN') {")).toBe(true);
    expect(flags('<SelectItem value="ADMIN">')).toBe(true);
  });

  it('does not treat a URL as the start of a comment', () => {
    // Without quote tracking, cutting at `//` truncates the line at the scheme
    // and silently drops anything after it — a false negative in code.
    expect(flags("const u = 'https://example.com'; const r = 'ADMIN';")).toBe(true);
  });

  it('keeps code that follows a closed block comment on the same line', () => {
    expect(flags("/* note */ const r = 'ADMIN';")).toBe(true);
  });

  it('does not scan the inside of a multi-line template literal', () => {
    // The false positive the per-line quote state produced. Prompt templates
    // in `lib/orchestration/` legitimately name roles in prose; with this
    // guard in ALWAYS_RUN_TESTS, flagging one is a red build over a string.
    const src = ['const PROMPT = `', "  Answer with 'USER' or 'ADMIN'.", '`;'].join('\n');

    expect(stripComments(src).some((l) => ROLE_LITERAL.test(l))).toBe(false);
  });

  it('still sees code after a template literal closes', () => {
    // The other direction: carrying template state must not swallow the rest
    // of the file once the backtick closes.
    const src = ['const P = `', '  hello', '`;', "const r = 'ADMIN';"].join('\n');

    expect(stripComments(src).some((l) => ROLE_LITERAL.test(l))).toBe(true);
  });

  it('still scans a ${} interpolation inside a template', () => {
    // The limit of treating templates as prose. An interpolated comparison is
    // real code and must not be hidden by the rule that protects the prose
    // around it.
    const src = ['const msg = `', "  ${user.role === 'ADMIN' ? 'yes' : 'no'}", '`;'].join('\n');

    expect(stripComments(src).some((l) => ROLE_LITERAL.test(l))).toBe(true);
  });

  it('contains an apostrophe in prose to its own line', () => {
    // A stray `'` — "step's output" inside a comment — must not leave the
    // scanner in string state for everything that follows.
    const src = ["// the step's output", "const r = 'ADMIN';"].join('\n');

    expect(stripComments(src).some((l) => ROLE_LITERAL.test(l))).toBe(true);
  });
});

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

  it('reaches the places a role check would actually live', () => {
    // Guards the scanner, not the code. A bare count cannot notice the scan
    // narrowing: `lib/` alone is hundreds of files, so losing a whole tree
    // leaves any plausible floor comfortably satisfied. These name the files
    // where a role gate would plausibly be written instead, including the two
    // that the original directory list did not reach at all.
    const scanned = new Set(scannedFiles());

    for (const file of [
      'lib/auth/guards.ts', //        the admin chokepoint
      'app/admin/layout.tsx', //      the admin tree gate
      'proxy.ts', //                  Next 16 middleware — outside every src dir
      'instrumentation.ts', //        boot, likewise at the root
      'components/maintenance-wrapper.tsx',
      'prisma/seeds/001-system-owner.ts',
    ]) {
      expect(scanned, `${file} must be scanned`).toContain(file);
    }
  });

  it('does not read its own exclusions', () => {
    // The other half of the property: the deny-list must actually deny, or the
    // guard reports every fixture in `tests/` and gets switched off.
    const scanned = new Set(scannedFiles());
    expect(scanned).not.toContain(OWNER);
    expect([...scanned].filter((f) => f.startsWith('tests/'))).toEqual([]);
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
