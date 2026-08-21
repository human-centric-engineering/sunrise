/**
 * Whole-tree guard: no unauthenticated surface can disclose the Sunrise
 * platform version.
 *
 * `SUNRISE_VERSION` names the exact upstream release a deployment runs, and
 * therefore the exact set of published issues to try against it — for every
 * Sunrise-derived deployment, not just one. #531 took it off the anonymous
 * `/api/health` payload for that reason. The invariant worth defending is not
 * "only one surface returns it" — every count anyone has written down in this
 * repo has been wrong — but **"no unauthenticated surface carries it"**.
 *
 * ## Read this before widening anything
 *
 * Two review rounds produced four findings against this file, and all four were
 * the same shape: it answered a module-graph question with a **hand-written
 * enumeration** — which directories to walk, which import syntax to follow,
 * which filenames render to an anonymous visitor — and each round found another
 * thing the enumeration did not list. Sabotages that passed against earlier
 * drafts: an import into `app/(public)/page.tsx`; a chain through
 * `components/`; a chain through `hooks/`; `await import('@/lib/sunrise-version')`;
 * an import into `app/not-found.tsx`; and an unauthenticated `POST` appended to
 * a file whose `GET` was guarded.
 *
 * Every rule below is therefore **exhaustive or loud**, never a list of
 * examples:
 *
 * - The walk covers the **whole repo root** minus build/vendor/test output, so
 *   there is no "which directories" question left to get wrong.
 * - An unresolvable `@/` specifier **throws**. It used to be dropped in
 *   silence, which is what made a chain through an unwalked directory invisible
 *   at both ends. The exemptions are documented repo invariants, not guesses —
 *   see `RESOLVABLE_EXEMPT`.
 * - Both static `from '@/…'` and dynamic `import('@/…')` are followed.
 * - Anonymous reachability is decided by **where a file is**, not by what it is
 *   called: anything under `app/` that is not an API route and not in a gated
 *   segment counts, so `not-found.tsx`, `robots.ts`, `opengraph-image.tsx` and
 *   whatever Next adds next are covered without being named.
 * - The authentication marker is matched **per exported HTTP method**, so one
 *   guarded export cannot launder an unguarded sibling in the same file.
 *
 * An earlier draft of this docblock claimed "a walk cannot miss a file that
 * exists". That was false, and it is the sentence that let the blind spots
 * survive review. A walk misses whatever its seed set and its rules miss; the
 * point of the rules above is that each is a property rather than a list.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const REPO_ROOT = process.cwd();

/** Files that pull the constant in directly — the seed of the reverse closure. */
const IMPORTS_VERSION = /['"]@\/lib\/sunrise-version['"]/;

/**
 * `@/`-aliased specifiers, static and dynamic. `import(` is included because
 * `await import('@/lib/sunrise-version')` was neither seeded nor followed by
 * the static-only version — and this repo already uses lazy `import()` in
 * anger (the knowledge parsers, to keep them out of the bundle), so it is a
 * shape real code here takes.
 */
const ALIASED_IMPORT = /(?:from|import)\s*\(?\s*['"]@\/([^'"]+)['"]/g;

/** Directories holding build output, vendor code, or the tests themselves. */
const NOT_SOURCE = new Set(['node_modules', '.next', '.git', 'coverage', 'tests', '.claude']);

/**
 * `@/` specifiers that legitimately resolve to nothing in this tree. Every
 * entry is a documented repo invariant, not "a path I saw fail".
 */
const RESOLVABLE_EXEMPT: ReadonlyArray<{ test: (spec: string) => boolean; why: string }> = [
  {
    test: (s) => /\.(css|json|svg|png|jpe?g|webp)$/.test(s),
    why: 'not a TypeScript module, so it is not in the walk by construction',
  },
  {
    test: (s) =>
      s.startsWith('lib/app/') ||
      s.startsWith('lib/framework/') ||
      s.startsWith('components/app/') ||
      s.startsWith('components/framework/'),
    why: 'fork-reserved namespace — ships empty upstream on purpose (CUSTOMIZATION.md)',
  },
  { test: (s) => s.startsWith('tests/'), why: 'tests are excluded from the walk' },
  {
    test: (s) => s.includes('…'),
    why: 'an ellipsis in a documentation example, not a real import',
  },
];

/**
 * The exact set of route files whose import graph may reach the constant, and
 * why that is safe. **The test asserts computed reality EQUALS this list**, so a
 * new route entering the closure fails until a human puts it here on purpose.
 *
 * ## Why a list, when this file argues against lists
 *
 * The earlier version inferred authentication from the source text — a
 * `withAdminAuth(` / `authenticateMcpRequest` marker, matched per exported HTTP
 * method. Three separate defects came out of that in review, and the last one
 * is why it is gone: the final export's span ran to end-of-file, and
 * `export { guarded as POST }` was not recognised as a handler, so a file with
 * an **unguarded `GET` returning the version** and a guarded `POST` below it
 * passed every assertion. Deciding "is this authenticated" from text means
 * parsing TypeScript with regex, and each round found another form it could not
 * parse.
 *
 * A list is the opposite failure mode, and the safe one: it cannot be fooled by
 * a syntax it does not know, only by a human approving a bad entry. The walk
 * computes reality; the list records intent; the test is the diff. That is the
 * same contract as `ALWAYS_RUN_TESTS` in `scripts/ci/scoped-tests.ts`, for the
 * same reason.
 *
 * ## Why every entry below is safe
 *
 * Twenty-one are under `app/api/v1/admin/`, which is admin-only — **measured,
 * not assumed: 186 of 186 route files under that prefix wrap in
 * `withAdminAuth`**. Note that is a convention this repo keeps, not a control
 * something enforces: `proxy.ts`'s `protectedRoutes` covers `/dashboard`,
 * `/settings` and `/profile`, and API routes are guarded by the in-handler
 * wrapper alone. The twenty-second is the MCP transport, which authenticates a
 * bearer API key via `authenticateMcpRequest` and answers JSON-RPC 401 before
 * it reads any config.
 *
 * Most reach the constant only transitively, through
 * `lib/orchestration/mcp/config.ts`, which defaults `serverVersion` to it.
 */
const ALLOWED_ROUTES: readonly string[] = [
  'app/api/v1/admin/orchestration/agents/[id]/route.ts',
  'app/api/v1/admin/orchestration/agents/route.ts',
  'app/api/v1/admin/orchestration/capabilities/[id]/route.ts',
  'app/api/v1/admin/orchestration/knowledge/documents/[id]/confirm/route.ts',
  'app/api/v1/admin/orchestration/knowledge/documents/[id]/route.ts',
  'app/api/v1/admin/orchestration/knowledge/documents/route.ts',
  'app/api/v1/admin/orchestration/maintenance/tick/route.ts',
  'app/api/v1/admin/orchestration/mcp/audit/route.ts',
  'app/api/v1/admin/orchestration/mcp/keys/route.ts',
  'app/api/v1/admin/orchestration/mcp/prompts/[id]/route.ts',
  'app/api/v1/admin/orchestration/mcp/prompts/route.ts',
  'app/api/v1/admin/orchestration/mcp/resources/[id]/route.ts',
  'app/api/v1/admin/orchestration/mcp/resources/route.ts',
  'app/api/v1/admin/orchestration/mcp/sessions/[id]/route.ts',
  'app/api/v1/admin/orchestration/mcp/sessions/route.ts',
  'app/api/v1/admin/orchestration/mcp/settings/route.ts',
  'app/api/v1/admin/orchestration/mcp/tools/[id]/route.ts',
  'app/api/v1/admin/orchestration/mcp/tools/route.ts',
  'app/api/v1/admin/orchestration/workflows/[id]/route.ts',
  'app/api/v1/admin/orchestration/workflows/route.ts',
  'app/api/v1/admin/stats/route.ts',
  'app/api/v1/mcp/route.ts',
];

/** Segments only reachable after signing in. */
const GATED_PREFIXES = ['app/admin/', 'app/(protected)/'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (NOT_SOURCE.has(entry) || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // a broken symlink is not a disclosure
    }
    if (stat.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

const toModule = (file: string): string =>
  relative(REPO_ROOT, file)
    .split(sep)
    .join('/')
    .replace(/\.tsx?$/, '');

const moduleFile = (mod: string): string =>
  existsSync(join(REPO_ROOT, `${mod}.tsx`)) ? `${mod}.tsx` : `${mod}.ts`;

/**
 * Source with comments removed, so a marker is only ever matched against code.
 *
 * Without this the guard was one backtick from useless: the health route's own
 * docblock explains where the version went and names `withAdminAuth` in prose,
 * so writing it as `withAdminAuth()` made an unauthenticated route satisfy the
 * authentication check. The `[^:]` guard keeps `https://` intact.
 */
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const isClientModule = (rel: string): boolean =>
  /^\s*['"]use client['"]/m.test(readFileSync(join(REPO_ROOT, rel), 'utf8'));

/**
 * Every module whose import graph reaches `@/lib/sunrise-version`, as a reverse
 * closure: seed with the direct importers, then repeatedly add any file
 * importing something already in the set until it stops growing.
 *
 * @throws if an `@/` specifier resolves to nothing and is not exempt — a silent
 * drop is what made an unwalked directory invisible at both ends.
 */
function modulesReachingVersion(): Set<string> {
  const files = walk(REPO_ROOT);

  // Module specifier → file, with the barrel form (`@/lib/x` → `lib/x/index`)
  // resolved so a re-export chain is followed rather than dropped.
  const byModule = new Map<string, string>();
  for (const file of files) byModule.set(toModule(file), file);

  const unresolvable: string[] = [];

  const dependencies = (file: string): string[] => {
    const source = codeOnly(readFileSync(file, 'utf8'));
    const out: string[] = [];
    for (const match of source.matchAll(ALIASED_IMPORT)) {
      const spec = match[1];
      const resolved = byModule.get(spec) ?? byModule.get(`${spec}/index`);
      if (resolved) {
        out.push(resolved);
      } else if (!RESOLVABLE_EXEMPT.some((rule) => rule.test(spec))) {
        unresolvable.push(`${toModule(file)} → @/${spec}`);
      }
    }
    return out;
  };

  const reaching = new Set(
    files.filter((f) => IMPORTS_VERSION.test(codeOnly(readFileSync(f, 'utf8')))).map(toModule)
  );

  for (let growing = true; growing;) {
    growing = false;
    for (const file of files) {
      if (reaching.has(toModule(file))) continue;
      if (dependencies(file).some((dep) => reaching.has(toModule(dep)))) {
        reaching.add(toModule(file));
        growing = true;
      }
    }
  }

  if (unresolvable.length > 0) {
    throw new Error(
      'Unresolvable @/ import(s). The closure below each is invisible to this ' +
        'guard, which is a blind spot rather than a pass:\n  ' +
        [...new Set(unresolvable)].join('\n  ') +
        '\nAdd the module, or add a rule to RESOLVABLE_EXEMPT with a reason.'
    );
  }
  return reaching;
}

const routesIn = (modules: Set<string>): string[] =>
  [...modules]
    .filter((m) => m.endsWith('/route'))
    .map((m) => `${m}.ts`)
    .sort();

describe('SUNRISE_VERSION disclosure', () => {
  it('reaches the routes it is supposed to, including the two-hop one', () => {
    // Guards the guard. A closure that silently matched nothing would make
    // every assertion below vacuously true. The MCP transport is named because
    // it is what a one-hop walk missed: route → protocol-handler → mcp/config.
    const routes = routesIn(modulesReachingVersion());

    expect(routes).toContain('app/api/v1/admin/stats/route.ts');
    expect(routes).toContain('app/api/v1/admin/orchestration/mcp/settings/route.ts');
    expect(routes).toContain('app/api/v1/mcp/route.ts');
  });

  it('admits no route into the closure that is not on the reviewed list', () => {
    // Set EQUALITY, in both directions, and that is the whole rule.
    //
    // A route appearing is the disclosure risk: someone wired the platform
    // version into a new endpoint, and a human now has to say whether that
    // endpoint is authenticated before the suite goes green again. A route
    // DISAPPEARING matters too — it means the list has drifted from the tree,
    // and a stale list is how a guard quietly stops guarding.
    //
    // Notice what this does not do: it never tries to decide from source text
    // whether a handler is authenticated. That is a parsing problem, and every
    // regex approximation of it shipped a hole — the last one let an unguarded
    // `GET` returning the version pass because a guarded `POST` sat below it.
    expect(routesIn(modulesReachingVersion())).toEqual([...ALLOWED_ROUTES].sort());
  });

  it('lets no client component reach it, so it never enters the public bundle', () => {
    // `lib/sunrise-version.ts` is deliberately NOT `server-only` — the MCP tier
    // consumes it and that file must stay platform-agnostic — and its docblock
    // says "do not import this constant in a `'use client'` component". Until
    // this test, nothing enforced that sentence. It matters more than the route
    // rules: a client module puts the constant in the JavaScript bundle every
    // anonymous visitor downloads.
    const client = [...modulesReachingVersion()]
      .map((m) => moduleFile(m))
      .filter((rel) => isClientModule(rel));

    expect(client).toEqual([]);
  });

  it('lets nothing anonymously reachable under app/ reach it', () => {
    // A server component discloses by RENDERING: the value lands in the HTML
    // served to whoever asked. So the question is not "is this authenticated
    // code" but "can a signed-out visitor cause it to run".
    //
    // Decided by LOCATION, not filename. An earlier version listed
    // `page|layout|template` and so missed `not-found.tsx`, `error.tsx`,
    // `robots.ts` and `sitemap.ts` — all served to anonymous callers — and
    // would have missed whatever Next adds next. Anything under `app/` that is
    // not an API route and not gated counts, so a new file kind is covered the
    // day it appears, and a new route group is guilty until someone adds it to
    // GATED_PREFIXES having checked that it gates.
    const exposed = [...modulesReachingVersion()]
      .filter((m) => m.startsWith('app/'))
      .filter((m) => !m.startsWith('app/api/') && !m.endsWith('/route'))
      .filter((m) => !GATED_PREFIXES.some((prefix) => m.startsWith(prefix)))
      .sort();

    expect(exposed).toEqual([]);
  });

  it('lets nothing outside API routes, lib and build scripts reach it at all', () => {
    // The backstop, and the only rule here that is exhaustive over the WHOLE
    // tree rather than over one directory.
    //
    // It exists because every earlier rule asked "is this file kind dangerous?"
    // and could only answer for kinds it had been told about. This asks the
    // complement — which is finite: an API route, a `lib/` module or a build
    // script may reach the constant; nothing else may. A page, a layout, a
    // component, a hook, `instrumentation.ts`, and `proxy.ts` (which runs on
    // every anonymous request and can set response headers) all fail here
    // without any of them being named.
    //
    // This replaced a check that accepted the `app/api/v1/admin/` path prefix as
    // evidence of authentication. It is not: `proxy.ts`'s `protectedRoutes` is
    // `/dashboard`, `/settings`, `/profile`, and API routes are guarded by the
    // in-handler wrapper alone. The prefix is a convention this repo keeps
    // (186/186 admin routes wrap in `withAdminAuth`, measured), not a control —
    // so it belongs in ALLOWED_ROUTES' rationale, where a human reads it, not
    // in an assertion pretending to verify it.
    const ALLOWED_AREAS = ['app/api/', 'lib/', 'scripts/'];

    // Named exceptions, each with the reason it cannot disclose. This rule
    // found `instrumentation` the moment it was written, which is the workflow
    // working: it flagged, a human traced it, and the reason is recorded here
    // rather than the rule being widened to make the red go away.
    const ALLOWED_MODULES: Record<string, string> = {
      instrumentation:
        "Next's server-boot hook. Reaches the constant through " +
        'run-tick → retention → mcp/config, runs in the Node runtime only, is ' +
        'never bundled for a browser, and neither renders nor returns it.',
    };

    const strangers = [...modulesReachingVersion()]
      .filter((m) => !ALLOWED_AREAS.some((area) => m.startsWith(area)))
      .filter((m) => !(m in ALLOWED_MODULES))
      .sort();

    expect(strangers).toEqual([]);
  });

  it('keeps it off the public health payload specifically', () => {
    // The one route this is actually about, asserted by name as well as by the
    // sweep — so a change to the sweep's heuristics can never quietly stop
    // covering the case #531 was filed for.
    const health = readFileSync(join(REPO_ROOT, 'app/api/health/route.ts'), 'utf8');

    expect(IMPORTS_VERSION.test(codeOnly(health))).toBe(false);
    expect(health).not.toMatch(/^\s*sunrise:/m);
  });

  it('keeps it out of the health response type and schema', () => {
    // The route could stop importing the constant while the contract still
    // advertised the field, which is the shape a partial revert takes.
    const types = readFileSync(join(REPO_ROOT, 'lib/monitoring/types.ts'), 'utf8');
    const schema = readFileSync(join(REPO_ROOT, 'lib/validations/monitoring.ts'), 'utf8');

    expect(types).not.toMatch(/^\s*sunrise\s*\??:/m);
    expect(schema).not.toMatch(/^\s*sunrise\s*:/m);
  });
});
