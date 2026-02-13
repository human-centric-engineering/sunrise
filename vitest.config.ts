import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    // Use happy-dom for fast DOM testing (alternative to jsdom)
    environment: 'happy-dom',

    // Global test setup file
    setupFiles: ['./tests/setup.ts'],

    // Include test files
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],

    // Exclude files
    exclude: ['node_modules', 'dist', '.next', 'coverage', '**/*.config.{js,ts}'],

    // Enable global test APIs (describe, it, expect, etc.)
    globals: true,

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
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

    // Test timeout (useful for async tests)
    testTimeout: 10000,

    // Mock CSS modules
    css: false,
  },

  // Resolve path aliases to match tsconfig.json
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
