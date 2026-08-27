/**
 * Unit Tests: the ESLint/Prettier caches must live where a routine reset can't reach
 *
 * `npm run lint` and `npm run format` cache their results. Until #677 those
 * caches lived under `.next/cache/`, which is Next.js's build-output directory
 * — and `rm -rf .next` is the reflex remedy for any stale-build symptom.
 * (`next build` itself preserves `.next/cache`; the loss path is the manual
 * wipe.) Deleting it took two caches that have nothing to do with the build,
 * and the bill arrived later and somewhere else: measured on a 4,414-file
 * fork, a cold `npm run lint` is 5.5 minutes against 2.5s warm.
 *
 * The same run peaks at 3.3GB RSS, which used to be the more dangerous half —
 * about 77% of Node's 4288MB default ceiling on a 16GB machine, close enough
 * that concurrent pressure turned `npm run validate` into a V8 abort (exit
 * 134) reading like a type error. In *this* tree that half is already absorbed:
 * `scripts/run-capped.mjs` caps eslint at 6144MB locally and CI sets
 * `CI_NODE_HEAP_MB` (default 5120), both comfortably above the peak. The
 * wall-clock cost is what this file is defending against; the memory story is
 * here because a fork predating `run-capped.mjs` still meets it.
 *
 * `node_modules/.cache/` is the other obvious home and is just as wrong: the
 * CI lint job restores its cache *before* `npm ci`, which deletes
 * `node_modules` wholesale. The repo root is the only location that survives
 * both `rm -rf .next` and `npm ci`, so the rule below is positive and total —
 * **a cache location must be a single root-level entry** — rather than a
 * blocklist of the volatile directories we happened to think of.
 *
 * The second half is the coupling that made the original bug invisible: CI
 * caches these files by path, in a different file, with no link back to the
 * scripts that write them. If the two drift, nothing breaks — CI just silently
 * pays for a cold run forever. So the workflow's cache paths are asserted to
 * be exactly the set the scripts actually produce.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT CATCH
 * ---------------------------------------------------------------------------
 *   • Cache locations set anywhere other than the four call sites read here
 *     (`package.json` scripts, `.lintstagedrc.json`) — an `.eslintrc`-style
 *     config key, a `NODE_OPTIONS`-ish env var, or a fork's own wrapper script.
 *   • Whether the cache is *effective*. A location can be correct and the
 *     strategy still wrong; `--cache-strategy content` is what makes a fresh
 *     checkout's reset mtimes not invalidate it, and that is asserted here only
 *     to the extent that both eslint call sites must agree on it.
 *   • Any other `actions/cache` entry in the workflow. The build job's
 *     `.next/cache` is deliberately unconstrained — that one *is* build output.
 *
 * FORK NOTE
 * ---------------------------------------------------------------------------
 * The CI half of this reads upstream's `.github/workflows/ci.yml` by step
 * name, and the entry in `ALWAYS_RUN_TESTS` makes it run on every scoped run.
 * A fork that owns that workflow — renamed step, or lint folded into a
 * workflow of its own — should drop the `ALWAYS_RUN_TESTS` entry and keep its
 * own version, rather than carry a red suite about a file it no longer shares.
 * The scripts half is worth keeping either way.
 *
 * @see .github/workflows/ci.yml — the lint job's cache step
 * @see .context/architecture/ci.md § Universal speedups
 * @see .context/testing/scoped-runs.md § For forks
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (relative: string) => readFileSync(join(ROOT, relative), 'utf8');

/** ESLint's own default when `--cache` is passed without a location. */
const ESLINT_DEFAULT_CACHE = '.eslintcache';

/** Prettier's, which is deliberately not the same shape — see `cacheFileFor`. */
const PRETTIER_DEFAULT_CACHE = 'node_modules/.cache/prettier/.prettier-cache';

/**
 * Every place the repo invokes eslint or prettier with caching on, paired with
 * the cache file that invocation ends up writing.
 *
 * Derived from the command strings rather than restated, so the guard is
 * testing what actually runs. A site whose command stops matching is a
 * failure, not a silent skip — see `it('finds every caching call site')`.
 */
function cachingCallSites(): { site: string; command: string }[] {
  // Narrowed at runtime rather than cast. A cast would let a config that stops
  // being string-shaped read as an empty roster, and an empty roster is a
  // guard that passes because it looked at nothing.
  const entriesOf = (value: unknown): [string, unknown][] =>
    typeof value === 'object' && value !== null ? Object.entries(value) : [];

  const commandsIn = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value]).filter((item) => typeof item === 'string');

  const pkg: unknown = JSON.parse(read('package.json'));
  const scripts = entriesOf(entriesOf(pkg).find(([key]) => key === 'scripts')?.[1]).flatMap(
    ([name, command]) =>
      commandsIn(command).map((c) => ({ site: `package.json "${name}"`, command: c }))
  );

  const lintStaged = entriesOf(JSON.parse(read('.lintstagedrc.json'))).flatMap(
    ([pattern, commands]) =>
      commandsIn(commands).map((command) => ({
        site: `.lintstagedrc.json "${pattern}"`,
        command,
      }))
  );

  return [...scripts, ...lintStaged].filter(
    ({ command }) => /\b(eslint|prettier)\b/.test(command) && command.includes('--cache')
  );
}

/**
 * The cache file a caching command writes: its explicit location, or the
 * tool's own default.
 *
 * The two defaults are nothing alike, and treating them alike is how this
 * guard would have gone quiet. ESLint defaults to `.eslintcache` in cwd, which
 * is exactly where this file wants it. Prettier defaults to
 * `findCacheDirectory({name:'prettier'})/.prettier-cache` — i.e.
 * `node_modules/.cache/prettier/.prettier-cache`, falling back to `os.tmpdir()`
 * (`node_modules/prettier/internal/legacy-cli.mjs`, `findCacheFile`). That is
 * the `npm ci`-volatile location the docblock above rejects by name, so
 * returning it is what makes dropping `--cache-location` from a `format`
 * script fail the root-level assertion with a message about prettier, rather
 * than pass by borrowing eslint's answer.
 */
function cacheFileFor(command: string): string {
  const explicit = /--cache-location[= ]+(\S+)/.exec(command)?.[1];
  if (explicit) return explicit.replace(/\/$/, '');
  return /\bprettier\b/.test(command) ? PRETTIER_DEFAULT_CACHE : ESLINT_DEFAULT_CACHE;
}

/** The `path:` entries of the lint job's `actions/cache` step, as written. */
function ciLintCachePaths(): string[] {
  const workflow = read('.github/workflows/ci.yml');
  const step = /name: Cache eslint \/ prettier results\n([\s\S]*?)\n {6}- /.exec(workflow)?.[1];
  // Loud, not lenient: a renamed step means this guard can no longer see what
  // CI caches, which is exactly the state it exists to prevent.
  expect(
    step,
    'ci.yml no longer has a step named "Cache eslint / prettier results" — this guard cannot check the CI cache paths'
  ).toBeDefined();

  const block = /path: \|\n([\s\S]*?)\n {10}key:/.exec(step ?? '')?.[1];
  expect(block, 'the lint cache step no longer declares a multi-line `path:` block').toBeDefined();

  return (block ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

describe('toolchain cache locations', () => {
  it('finds every caching call site', () => {
    const sites = cachingCallSites().map(({ site }) => site);

    // The known roster. A new caching invocation is welcome — add it here and
    // the rules below start applying to it. A *missing* one means a command
    // was renamed or restructured and this guard silently stopped covering it.
    expect(sites).toEqual(
      expect.arrayContaining([
        'package.json "lint"',
        'package.json "lint:fix"',
        'package.json "format"',
        'package.json "format:check"',
        '.lintstagedrc.json "*.{js,jsx,ts,tsx,mjs,cjs}"',
      ])
    );
  });

  it.each(cachingCallSites())(
    'caches at the repo root, not inside a directory a reset deletes — $site',
    ({ command }) => {
      const location = cacheFileFor(command);

      // Positive and total: one root-level entry. `.next/cache/...` dies to
      // `rm -rf .next`; `node_modules/.cache/...` dies to `npm ci`; anything
      // else nested is a location nobody thought about.
      expect(location, `cache location "${location}" is not a root-level entry`).not.toContain('/');
      expect(location.startsWith('.')).toBe(true);
    }
  );

  it('keeps both eslint call sites on the same cache strategy', () => {
    // They share one cache file, so a metadata-strategy writer and a
    // content-strategy writer would fight over the same entries.
    const eslintSites = cachingCallSites().filter(({ command }) => /\beslint\b/.test(command));

    expect(eslintSites.length).toBeGreaterThan(1);
    for (const { site, command } of eslintSites) {
      expect(command, `${site} must pass --cache-strategy content`).toContain(
        '--cache-strategy content'
      );
    }
  });

  it('git-ignores every cache file it writes', () => {
    const ignored = read('.gitignore')
      .split('\n')
      .map((line) => line.trim().replace(/^\//, ''));

    for (const { site, command } of cachingCallSites()) {
      const file = cacheFileFor(command);
      expect(ignored, `${file} (written by ${site}) is not in .gitignore`).toContain(file);
      expect(ignored, `${file} is un-ignored by a negation`).not.toContain(`!${file}`);
    }
  });

  it('keeps every cache file out of the Docker build context', () => {
    // Root-level means "in the build context". `Dockerfile` does `COPY . .` in
    // both the builder and seeder stages, so a cache file the build context
    // can see is a file that changes on every lint run, invalidates that layer
    // and reruns `next build` — and ships inside the seeder image. Under
    // `.next/` these were covered by that entry; at the root they need their own.
    const ignored = read('.dockerignore')
      .split('\n')
      .map((line) => line.trim());

    for (const { site, command } of cachingCallSites()) {
      const file = cacheFileFor(command);
      expect(ignored, `${file} (written by ${site}) is not in .dockerignore`).toContain(file);
    }
  });

  it('caches exactly those files in CI, so the workflow cannot drift from the scripts', () => {
    const written = [...new Set(cachingCallSites().map(({ command }) => cacheFileFor(command)))];

    expect(ciLintCachePaths().sort()).toEqual(written.sort());
  });
});
