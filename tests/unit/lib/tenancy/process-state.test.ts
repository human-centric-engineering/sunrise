/**
 * Coverage guard: lib/tenancy/process-state.ts vs the actual `lib/` tree
 *
 * RLS cannot see a Node heap. A `Map` a module built five minutes ago and is
 * about to serve to a different org is a cross-tenant read that no policy and
 * no review of a SQL statement will catch, so the control has to be a build
 * failure rather than a checklist. This is that failure.
 *
 * It holds the manifest level with the tree in BOTH directions:
 *
 *   • a module-level holder with no row fails — the new cache nobody classified;
 *   • a row whose holder is gone fails — a stale row is a lie that reads like
 *     a decision, and it is the failure mode a hand-written roster actually
 *     has. (`feedback: hand-derived lists that claim authority`.)
 *
 * Same shape as `tests/unit/lib/privacy/export-sources.test.ts`: a
 * hand-written roster, and a scanner that proves it complete.
 *
 * ---------------------------------------------------------------------------
 * IF THIS TEST IS FAILING
 * ---------------------------------------------------------------------------
 * You added (or removed) module-level mutable state in `lib/`. Add a row to
 * `PROCESS_STATE` with a posture, choosing it by asking: **if two orgs used
 * this install, could one org's entry be served to the other?** The postures
 * and the question are documented on `TenancyPosture`.
 *
 * Deleting a row to make this pass ships a cache nobody has classified.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCANNER MATCHES, AND WHAT IT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * Calibrated against this tree (105 holders in 66 files at the time of
 * writing; the manifest declares 108, the extra three being shapes below
 * that it cannot see), then narrowed until it had no false positives. It
 * matches, at
 * column 0 only — Prettier indents everything nested, so column 0 IS module
 * scope:
 *
 *   • every `let` / `var` — a mutable module-level binding is state whatever
 *     it holds;
 *   • `const x = new Ctor(...)` for any constructor;
 *   • `const x = globalThis as ...` — the cross-module-graph singleton bag.
 *
 * It excludes, by measurement rather than by taste:
 *
 *   • `const X = new Set([...])` / `new Map([[...]])` — an inline array literal
 *     argument makes it a lookup table, written once at module load from
 *     literals and never again. 32 of them in `lib/`, none of them state.
 *   • `new TextEncoder()` / `new TextDecoder()` — stateless codecs.
 *
 * And it cannot see, which is why the review-checklist entry in
 * `.context/tenancy/context.md` exists as well as this test:
 *
 *   • a holder built by a factory call — `const c = createCache()`;
 *   • a holder nested inside an object or array literal — `RATE_LIMIT_TIERS`;
 *   • a holder assigned through `??=` from a globalThis bag — `contributors`
 *     in `context-builder.ts`.
 *
 * All three ARE in the manifest, by hand. A row may name a holder the scanner
 * would not have demanded; the completeness check is one-way.
 *
 * @see lib/tenancy/process-state.ts
 * @see .context/architecture/multi-tenancy.md
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

import { PROCESS_STATE, type ProcessStateDeclaration } from '@/lib/tenancy/process-state';

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const LIB_DIR = path.join(REPO_ROOT, 'lib');

/** Reserved for downstream forks — never scanned (`platform.reserved-tiers`). */
const RESERVED_TIERS = ['app', 'framework'];

/** Containers whose inline-array-literal form is a lookup table, not state. */
const LOOKUP_CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

/** Constructors that hold nothing between calls. */
const STATELESS_CONSTRUCTORS = new Set(['TextEncoder', 'TextDecoder']);

/**
 * A module-level `const` / `let` / `var`, at column 0. The trailing character
 * class admits an uninitialised `let x;` as well as the annotated and assigned
 * forms. A multi-declarator (`let a, b;`) would yield only its first name —
 * there are none in `lib/`, and the repo's style does not produce them.
 */
const DECLARATION = /^(?:export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)(?=\s*[:=;])/;

interface Holder {
  name: string;
  line: number;
}

/** Every module-level binding name in a source file, whatever it holds. */
export function moduleLevelNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split('\n')) {
    const match = DECLARATION.exec(line);
    if (match) names.add(match[2]);
  }
  return names;
}

/**
 * The module-level holders that count as process-global state — the roster's
 * completeness is measured against this, and only this.
 */
export function findStateHolders(source: string): Holder[] {
  const lines = source.split('\n');
  const holders: Holder[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = DECLARATION.exec(lines[i]);
    if (!match) continue;
    const [, kind, name] = match;

    if (kind !== 'const') {
      holders.push({ name, line: i + 1 });
      continue;
    }

    // A `const` initialiser can wrap across lines (`new Map<\n  string,\n>()`),
    // so read a short window and test its START — anchoring means a following
    // statement inside the window cannot produce a match of its own.
    const window = lines.slice(i, i + 6).join('\n');
    const initialiser = initialiserOf(window, match[0].length);
    if (initialiser === null) continue;

    if (/^(\[\s*\]|\{\s*\})/.test(initialiser)) {
      // An EMPTY array or object literal: a holder something fills later.
      // A populated one (`const SUBS = [[/x/, 'y']]`) is a constant table and
      // is not matched, which is the same literal-versus-state line the
      // lookup-container rule draws.
      holders.push({ name, line: i + 1 });
      continue;
    }

    if (/^globalThis\b/.test(initialiser)) {
      holders.push({ name, line: i + 1 });
      continue;
    }

    const construction = /^new\s+([A-Za-z_$][\w$.]*)\s*(?:<[\s\S]*?>)?\s*\(\s*/.exec(initialiser);
    if (!construction) continue;

    const constructor = construction[1];
    if (STATELESS_CONSTRUCTORS.has(constructor)) continue;
    const firstArgument = initialiser.slice(construction[0].length);
    if (LOOKUP_CONTAINERS.has(constructor) && firstArgument.startsWith('[')) continue;

    holders.push({ name, line: i + 1 });
  }

  return holders;
}

/**
 * The text after the declaration's `=`, or `null` when there is no assignment.
 *
 * Not `indexOf('=')`: the first `=` in
 * `const handlers: Map<string, (x: T) => void> = new Map();` belongs to the
 * arrow in the type annotation, which would make the initialiser `> void> =
 * new Map();` and silently skip the holder. So it scans from the end of the
 * declaration keyword and name, skipping `=>` and anything inside brackets.
 */
function initialiserOf(window: string, from: number): string | null {
  let depth = 0;
  for (let i = from; i < window.length; i++) {
    const char = window[i];
    if (char === '<' || char === '(' || char === '[' || char === '{') depth++;
    else if (char === '>' || char === ')' || char === ']' || char === '}') depth--;
    else if (char === '=' && depth <= 0) {
      if (window[i + 1] === '>' || window[i - 1] === '=') continue;
      return window.slice(i + 1).trim();
    } else if (char === ';' && depth <= 0) {
      return null;
    }
  }
  return null;
}

function scannableFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === LIB_DIR && RESERVED_TIERS.includes(entry.name)) continue;
      scannableFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(path.relative(REPO_ROOT, full));
    }
  }
  return out;
}

const FILES = scannableFiles(LIB_DIR);
const SOURCES = new Map(
  FILES.map((file) => [file, readFileSync(path.join(REPO_ROOT, file), 'utf8')])
);

/** Every `file → holder` pair the manifest declares. */
function declaredPairs(rows: readonly ProcessStateDeclaration[]): Set<string> {
  const pairs = new Set<string>();
  for (const row of rows) {
    for (const holder of row.holders) pairs.add(`${row.file}#${holder}`);
  }
  return pairs;
}

describe('the scanner itself', () => {
  it('matches a mutable binding, a constructed container and a globalThis bag', () => {
    const source = [
      'let cachedAt = 0;',
      'const cache = new Map<string, Entry>();',
      'const bag = globalThis as unknown as { x?: number };',
      'var legacy;',
    ].join('\n');

    expect(findStateHolders(source).map((h) => h.name)).toEqual([
      'cachedAt',
      'cache',
      'bag',
      'legacy',
    ]);
  });

  it('matches a container whose constructor wraps across lines', () => {
    const source = ['const appCapabilities = new Map<', '  string,', '  Capability', '>();'].join(
      '\n'
    );
    expect(findStateHolders(source).map((h) => h.name)).toEqual(['appCapabilities']);
  });

  it('excludes a literal lookup table and a stateless codec', () => {
    const source = [
      "const TERMINAL = new Set(['completed', 'failed']);",
      "const TYPED = new Set<string>(['a']);",
      'const encoder = new TextEncoder();',
    ].join('\n');
    expect(findStateHolders(source)).toEqual([]);
  });

  it('matches an empty array or object a module fills later, not a populated one', () => {
    const source = [
      'const appRules: RateLimitRule[] = [];',
      'const registry: Record<string, Handler> = {};',
      "const SUBS: Array<[RegExp, string]> = [[/a/g, 'b']];",
      "const DEFAULTS = { mode: 'log_only' };",
    ].join('\n');
    expect(findStateHolders(source).map((h) => h.name)).toEqual(['appRules', 'registry']);
  });

  it('finds the assignment past an arrow inside a type annotation', () => {
    // `indexOf('=')` lands on the `=` of `=>` here and skips the holder.
    const source = 'const handlers: Map<string, (x: T) => void> = new Map();';
    expect(findStateHolders(source).map((h) => h.name)).toEqual(['handlers']);
  });

  it('ignores a declaration with no assignment at all', () => {
    expect(findStateHolders('const enum Mode { A }').map((h) => h.name)).toEqual([]);
  });

  it('excludes anything indented — a class field is not module scope', () => {
    const source = ['class Limiter {', '  private buckets = new Map<string, number>();', '}'].join(
      '\n'
    );
    expect(findStateHolders(source)).toEqual([]);
  });

  it('does not let a following statement inside its lookahead window match', () => {
    // The declaration that bit: a trailing comment means the line does not end
    // in `;`, and a `new Map` four lines later belongs to something else.
    const source = [
      'const WINDOW_MS = 60_000; // 1 minute',
      '',
      'export class McpRateLimiter {',
      '  private limiters = new Map<string, Bucket>();',
      '}',
    ].join('\n');
    expect(findStateHolders(source)).toEqual([]);
  });
});

describe('PROCESS_STATE covers the tree', () => {
  it('scans a lib tree that is actually there', () => {
    // "I could not look" must never read as "I found nothing"
    // (.context/architecture/checks.md). A wrong root would silently pass
    // every assertion below.
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain('lib/tenancy/context.ts');
  });

  it('declares every module-level holder in lib/', () => {
    const declared = declaredPairs(PROCESS_STATE);
    const undeclared: string[] = [];

    for (const [file, source] of SOURCES) {
      for (const holder of findStateHolders(source)) {
        if (!declared.has(`${file}#${holder.name}`)) {
          undeclared.push(`${file}:${holder.line} ${holder.name}`);
        }
      }
    }

    expect(undeclared).toEqual([]);
  });

  it('declares no holder that has gone', () => {
    const stale: string[] = [];

    for (const row of PROCESS_STATE) {
      const source = SOURCES.get(row.file);
      if (source === undefined) {
        stale.push(`${row.file} — no such file under lib/`);
        continue;
      }
      const names = moduleLevelNames(source);
      for (const holder of row.holders) {
        if (!names.has(holder)) stale.push(`${row.file} — no module-level \`${holder}\``);
      }
    }

    expect(stale).toEqual([]);
  });

  it('skips the reserved fork tiers', () => {
    expect(FILES.filter((f) => f.startsWith('lib/app/') || f.startsWith('lib/framework/'))).toEqual(
      []
    );
  });
});

describe('every row says something a reader can act on', () => {
  it('gives each row a why, and each keyed posture a key', () => {
    for (const row of PROCESS_STATE) {
      expect(row.why.length, `${row.file} why`).toBeGreaterThan(20);
      expect(row.holders.length, `${row.file} holders`).toBeGreaterThan(0);
      if (row.posture === 'row-keyed' || row.posture === 'org-keyed') {
        expect(row.keyedBy, `${row.file} keyedBy`).toBeTruthy();
      }
    }
  });

  it('names a task for every declared defect, so nothing sits in mixes-orgs quietly', () => {
    for (const row of PROCESS_STATE.filter((r) => r.posture === 'mixes-orgs')) {
      expect(row.why, `${row.file} must name the task that fixes it`).toMatch(/\bt-\d+\b/);
    }
  });

  it('declares each file+holder once', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const row of PROCESS_STATE) {
      for (const holder of row.holders) {
        const key = `${row.file}#${holder}`;
        if (seen.has(key)) duplicates.push(key);
        seen.add(key);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
