import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { availableParallelism } from 'node:os';
import { nextFontStub } from './tests/mocks/next-font-plugin';

export default defineConfig({
  // `nextFontStub` stands in for `next/font/*`, which the Next compiler strips
  // at build time and Vitest therefore cannot execute. See the plugin's header.
  plugins: [react(), nextFontStub()],
  test: {
    // `node` by default; a DOM is opt-in per file via an environment docblock
    // on line 1. 405 files carry one; 682 run on node.
    //
    // Vitest builds a fresh environment for every test file, and constructing a
    // happy-dom Window means building the whole browser API surface — window,
    // document, CSSOM, its own fetch. Measured back-to-back on `tests/unit/lib`
    // (434 files) under identical load: 49.3s wall / 141s CPU with this split
    // against 58.1s / 191s with happy-dom everywhere, and in-worker environment
    // construction of 11.4s against 79.5s. Read the CPU and environment figures
    // rather than the wall clock — wall varies with what else is running, and
    // aggregate work is the thing this repo is short of.
    //
    // IT IS ALSO A CORRECTNESS FIX, which is the better half of the argument.
    // happy-dom defines `window`, so `lib/env.ts`'s `typeof window !==
    // 'undefined'` check selected the **client** schema and every server
    // variable read as `undefined`. Anything branching on `TENANCY_MODE`,
    // `CAPABILITY_BINDING_MODE` or `MCP_SESSION_MODE` was silently exercising
    // the undefined path. 44 of the 47 test files that import `@/lib/env` now
    // run under node and see the real server schema; the remaining three are
    // two component tests and `env.test.ts`, which asserts on `typeof window`
    // deliberately.
    //
    // GETTING IT WRONG IS ASYMMETRIC, and the docs are precise about this
    // because an earlier draft of this comment was not. A DOM test that lands
    // on node fails loudly (`ReferenceError: document is not defined`). A node
    // test that picks up happy-dom **passes**, and quietly rejoins the class of
    // test this setting exists to escape. So over-declaring is not free, and
    // `tests/unit/vitest-environment-directives.test.ts` guards the mechanical
    // half of it — placement, duplicate values, unknown environment names. It
    // cannot tell you a file did not need the DOM it asked for; only running it
    // without one can. See `.context/testing/environments.md`.
    //
    // WHY A DOCBLOCK AND NOT A GLOB. `environmentMatchGlobs` was removed in
    // vitest 3 and is absent from 4. Its replacement, `test.projects`, would
    // work — but a projects config makes `vitest list --filesOnly` prefix every
    // line with `[name] `, and `scripts/ci/run-scoped-tests.ts` (the
    // `npm run test:changed` gate) resolves its selection from exactly that
    // output and refuses a line it cannot resolve to a file. Choosing projects
    // here would have broken the gate that shipped one PR earlier.
    environment: 'node',

    // Cap worker forks well below the core count.
    //
    // Vitest defaults to roughly `cores - 1`, which is right for a machine
    // running one suite and wrong for how this suite is actually run: agents
    // execute it in the background behind `validate` and `/pre-pr`, and more
    // than one of them is often working different forks of this repo at the
    // same time. Two default runs on a 10-core box is ~18 forked processes,
    // and the machine thrashes. (Before the node-by-default split above, every
    // one of those also built its own happy-dom.)
    //
    // The failure that produces is not a test failure and does not read like
    // one: `[vitest-pool]: Failed to start forks worker` / `Timeout waiting
    // for worker to respond`, plus tests that hang to the 30s `testTimeout`
    // rather than asserting. It also silently shrinks the file count in the
    // summary line — a run reporting 1054 of 1058 files has lost four workers,
    // not four test files. That is a large share of what #597 recorded as
    // flakiness, and no application-code change can fix it.
    //
    // Measured on a 10-core M1 Pro: capping to 4 costs ~6% wall-clock on a
    // solo coverage run (239s -> 254s) while cutting the aggregate work the
    // machine does by roughly half (summed in-worker `tests` time 860s ->
    // 326s). The default was not buying parallelism, it was buying
    // contention — which is why the headroom for a second concurrent run
    // goes up far more than the 6% suggests.
    //
    // Left uncapped on CI deliberately. The problem above is a shared-dev-box
    // problem; a CI shard has a runner to itself, and runner size varies by
    // fork — `ubuntu-latest` is 4 vCPU for a public repo but 2 for a private
    // one on a free plan, where a hardcoded 4 would oversubscribe. Vitest's
    // own default sizing is right there, so this keeps CI exactly as it is.
    //
    // Expressed as a min against vitest's own default rather than a flat 4: a
    // literal is a *floor* on a small machine, not a cap. On a 4-core laptop a
    // bare 4 would raise the count; on a 2-core box it would oversubscribe
    // fourfold — the exact thrash this setting exists to prevent.
    //
    // Taken against the WATCH default specifically. Vitest has two:
    // `max(cores - 1, 1)` for `vitest run`, and `max(floor(cores / 2), 1)` for
    // watch (`resolveMaxWorkers`), and every local script here — `test`,
    // `test:watch`, `test:coverage` — is watch mode on an interactive
    // terminal. `resolveMaxWorkers` returns an explicit `maxWorkers` *before*
    // it reaches the watch branch, so sizing against `cores - 1` still raised
    // the count on a 4-core (2 → 3) and 6-core (3 → 4) machine. The watch
    // default is the smaller of the two, so a min against it never raises in
    // either mode, and still yields the measured 4 from ~8 cores up.
    maxWorkers: process.env.CI
      ? undefined
      : Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2))),

    // Applies to the files that opt into happy-dom above.
    //
    // happy-dom loads `<script src>` and `<link rel=stylesheet>` for real —
    // both flags default to false, i.e. loading enabled — using its own
    // `node:http` client in `happy-dom/lib/fetch/`. Its default document URL
    // is `http://localhost:3000`, so every relative asset in a rendered
    // component resolved there and was fetched over the network, producing
    // ~600 `ECONNREFUSED ::1:3000` lines per run. Because that client is
    // internal to happy-dom, patching `globalThis.fetch` does not intercept
    // it, which is what made the noise so hard to attribute (#597).
    //
    // Nothing in the suite asserts on a fetched stylesheet or script, so
    // turning both off removes the network entirely. Image loading is already
    // off by default (`enableImageFileLoading`).
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },

    // Global test setup file
    setupFiles: ['./tests/setup.ts'],

    // Include test files
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    // Exclude files. `tests/e2e` is forward-looking: Sunrise ships no Playwright
    // suite, but a fork that adds one puts specs there using the conventional
    // `.spec.ts` suffix, which the include glob above would otherwise collect.
    // Vitest would then run files importing `@playwright/test`, and the failures
    // don't obviously say "wrong runner". Costs nothing while the dir is absent.
    exclude: [
      'node_modules',
      'dist',
      '.next',
      'coverage',
      '**/*.config.{js,ts}',
      '.claude/**',
      'tests/e2e/**',
    ],

    // Enable global test APIs (describe, it, expect, etc.)
    globals: true,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'tests/',
        // Smoke *harnesses* are a test tier, not production code — standalone
        // tsx entry points that exercise a slice against the real dev database
        // (see scripts/smoke/README.md). vitest never executes them, so their
        // coverage is structurally 0% and every edit to one would fail the
        // per-file gate that #647 added.
        //
        // The extglob excludes the harnesses and deliberately does NOT exclude
        // `*-assertions.ts`, the convention for the pure logic a harness
        // extracts to make it testable. Excluding the tree wholesale — the
        // first version of this line — swallowed
        // `scripts/smoke/export-assertions.ts`, which has its own test, and
        // made the gate vacuous for the one file in here it should apply to:
        // coverage reported `0/0 Unknown%` and exited 0. Note that the vitest
        // coverage `exclude` option does not honour `!`-negated entries, so the
        // re-include has to be expressed inside the pattern.
        //
        // `scripts/ci/**` is deliberately NOT excluded: that code is ordinary
        // production tooling and is unit-tested.
        'scripts/smoke/!(*-assertions).ts',
        // Same category, same shape: `scripts/db/check-drift.ts` is a CLI
        // entrypoint that probes a live database for the objects Prisma cannot
        // model. Nothing imports it, so it is absent from a full coverage run
        // altogether and only materialises at 0% when a scoped run forces it
        // in — which is why a fork's sync merge met it and upstream never did
        // (#671). `*-assertions.ts` is spared here too, so pure logic extracted
        // from a probe script stays gated.
        'scripts/db/!(*-assertions).ts',
        '**/*.d.ts',
        '*.config.{js,ts,mjs,cjs}', // root-level tool configs only (next.config.ts, tailwind.config.ts, etc.)
        // The pattern above is root-level ONLY, by design, so this seam needs
        // naming. `lib/app/eslint.config.mjs` is fork-owned scaffold that
        // Sunrise ships as `export default []` — a flat-config array, not
        // logic, and nothing imports it into a test. It became reachable when
        // `coverageTargets` stopped filtering to `.ts`/`.tsx` (#687); without
        // this line a fork editing its OWN seam file would fail a coverage gate
        // on a file it is explicitly invited to edit.
        'lib/app/eslint.config.mjs',
        // Same category as `scripts/smoke/**` above: a standalone probe, run by
        // hand against a real database, that vitest never executes. Structurally
        // 0%, so the per-file gate would fail on any edit to it.
        'scripts/spikes/**',
        '**/types/**',
        '.next/',
        'coverage/',
        'prisma/',
        'emails/',
        'public/',
        'app/**/layout.tsx', // Exclude layouts from coverage
        'app/**/loading.tsx', // Exclude loading states
        'app/**/error.tsx', // Exclude error boundaries
        'app/**/not-found.tsx', // Exclude 404 pages
        // Fork-owned placeholder marketing copy, not logic. Every fork rewrites
        // or deletes it, so a core test pinning its content would be a core test
        // a fork cannot satisfy — see the docblock in the file. The overwrite
        // risk that remains is covered structurally by
        // tests/unit/app/route-module-distinctness.test.ts.
        'app/\\(public\\)/page.tsx', // parens are picomatch syntax — escape or it matches nothing
        'lib/env.ts', // Exclude env validation
      ],
      // Coverage thresholds
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },

    // Test timeout (useful for async tests). 10s is comfortable for the
    // platform's own suite but tight once a fork adds heavier component and
    // integration tests — async server-component renders and `userEvent`-driven
    // form flows do 1-3s of real work and inflate well past that under CI
    // contention. The resulting failures are flaky rather than deterministic,
    // which makes them expensive to chase, so the default is generous.
    testTimeout: 30000,

    // Mock CSS modules
    css: false,
  },

  // Resolve path aliases to match tsconfig.json
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
      // ioredis is an optional peer dependency not installed in this project.
      // Aliasing it to the manual mock stub allows RedisRateLimitStore to be
      // imported in unit tests without a real Redis connection.
      ioredis: path.resolve(__dirname, './tests/mocks/ioredis.ts'),
      // Allow tests to import mock helpers via @mocks/ alias
      '@mocks': path.resolve(__dirname, './tests/mocks'),
    },
  },
});
