import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { nextFontStub } from './tests/mocks/next-font-plugin';

export default defineConfig({
  // `nextFontStub` stands in for `next/font/*`, which the Next compiler strips
  // at build time and Vitest therefore cannot execute. See the plugin's header.
  plugins: [react(), nextFontStub()],
  test: {
    // Use happy-dom for fast DOM testing (alternative to jsdom)
    environment: 'happy-dom',

    // Cap worker forks well below the core count.
    //
    // Vitest defaults to roughly `cores - 1`, which is right for a machine
    // running one suite and wrong for how this suite is actually run: agents
    // execute it in the background behind `validate` and `/pre-pr`, and more
    // than one of them is often working different forks of this repo at the
    // same time. Two default runs on a 10-core box is ~18 forked processes,
    // each with its own happy-dom, and the machine thrashes.
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
    maxWorkers: process.env.CI ? undefined : 4,

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
        '**/*.d.ts',
        '*.config.{js,ts,mjs,cjs}', // root-level tool configs only (next.config.ts, tailwind.config.ts, etc.)
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
