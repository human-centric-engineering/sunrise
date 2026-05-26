import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'dist/**',
      '.vercel/**',
      '.swc/**',
      'public/**',
      'next-env.d.ts',
      // Agent scratch checkouts — each worktree carries its own tsconfig.json,
      // and `tseslint.configs.recommendedTypeChecked` with `projectService: true`
      // would load every one, exhausting the ESLint heap.
      '.claude/worktrees/**',
      // Throwaway scripts (one-shot codemods, scratch utilities). Gitignored
      // but visible to eslint without this exclusion.
      '.claude/tmp/**',
    ],
  },

  // Base JavaScript configuration
  js.configs.recommended,

  // TypeScript configuration for TS/TSX files only
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-assertions': [
        'error',
        {
          assertionStyle: 'as',
          objectLiteralTypeAssertions: 'never',
        },
      ],
      // Require explicit return/argument types only at *module boundaries*
      // (exported functions) — the cross-module contracts where an inferred
      // type silently drifting is a real maintenance hazard. We deliberately
      // do NOT use `explicit-function-return-type` (which flags every
      // file-local helper too): annotating internal helpers is ceremony, the
      // same reason component returns aren't annotated (see the `.tsx`
      // override below). See `.context/architecture/lint-toolchain.md`.
      '@typescript-eslint/explicit-module-boundary-types': [
        'error',
        {
          allowArgumentsExplicitlyTypedAsAny: false,
          allowDirectConstAssertionInArrowFunctions: true,
          allowHigherOrderFunctions: true,
          allowTypedFunctionExpressions: true,
        },
      ],
    },
  },

  // React components are exported but their return type (`React.JSX.Element`,
  // or `Promise<…>` for async Server Components) is ceremony the ecosystem
  // infers reliably — and annotating it is error-prone for components that
  // return null or are async. So module-boundary types are off for `.tsx`.
  {
    files: ['**/*.tsx'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // JavaScript files (config files, etc.) - no type checking
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        module: 'readonly',
        require: 'readonly',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },

  // React configuration
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      'jsx-a11y': jsxA11yPlugin,
      '@next/next': nextPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactPlugin.configs['jsx-runtime'].rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11yPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,

      // React Compiler ruleset. eslint-plugin-react-hooks 7.1's `recommended`
      // preset turns the full ruleset on, but Sunrise does NOT run the React
      // Compiler (no babel-plugin-react-compiler / `reactCompiler` flag). The
      // rules split in two:
      //   - Correctness rules — rules-of-hooks, refs, purity, error-boundaries,
      //     set-state-in-render, immutability, globals — catch real bugs whether
      //     or not the compiler runs. Kept at the preset's `error`.
      //   - Optimization-only advisories flag code the compiler can't
      //     auto-memoize. With no compiler running they warn about an
      //     optimization we don't use, so they are off (not deferred-as-warn —
      //     off). The two below cover ~67 sites that are all intentional
      //     patterns, not bugs. See `.context/architecture/lint-toolchain.md`.
      // `exhaustive-deps` (preset `warn`) stays on — it catches real stale-
      // closure bugs and is compiler-independent.
      'react-hooks/set-state-in-effect': 'off', // advisory (extra render); the real bug, set-state-in-render, stays error
      'react-hooks/incompatible-library': 'off', // RHF watch() — only matters under the compiler

      // Custom rules
      'no-console': 'error',
      'react/react-in-jsx-scope': 'off', // Not needed with Next.js
      'react/prop-types': 'off', // Using TypeScript

      // Enforce @/ alias for all intra-repo imports.
      // Rationale: this is a starter template — downstream forks copy and
      // move folders. The @/ alias survives folder moves, gives /pre-pr
      // and /code-review a deterministic grep-checkable rule, and removes
      // "is this local or cross-module?" judgment calls. See CLAUDE.md.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['./*', '../*'],
              message: 'Use the @/ path alias instead of relative imports (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },

  // CLI-style verification + maintenance scripts. They print to stdout
  // for interactive use; logger's structured-JSON output would be
  // unreadable for an operator running them by hand.
  {
    files: ['scripts/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },

  // Test file overrides to prevent auto-fix issues with async/await
  {
    files: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
    rules: {
      // Disable require-await rule for test files
      // Reason: Vitest test functions often use helper functions that internally await,
      // or use matchers like expect().rejects.toThrow() where async appears "unused"
      // Auto-fix removing async breaks tests. See: .claude/skills/testing/gotchas.md
      '@typescript-eslint/require-await': 'off',

      // Disable unbound-method rule for test files
      // Reason: Vitest mocks using vi.mocked() are safe and don't need this binding
      // This is the standard Vitest pattern from official documentation
      // See: .claude/skills/testing/LINTING-ANALYSIS.md
      '@typescript-eslint/unbound-method': 'off',

      // Allow 'any' type in test files
      // Reason: Type workarounds are necessary for complex mock types (Headers, Session, PrismaPromise)
      // Tests prioritize runtime behavior over strict compile-time types
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Allow console in tests (for debugging)
      'no-console': 'off',

      // Allow object literal type assertions in tests (partial mocks)
      // Reason: Tests commonly use `{} as MockType` for partial mocks of complex interfaces
      '@typescript-eslint/consistent-type-assertions': 'off',

      // Skip return type annotations in tests
      // Reason: Test helpers/factories don't benefit from explicit return types
      '@typescript-eslint/explicit-module-boundary-types': 'off',

      // Disable the React Compiler render-purity rules for tests. Test
      // components intentionally do "impure" things a shipped component never
      // would — assigning render output to an outer variable to assert on it,
      // mutating shared fixtures. `rules-of-hooks` stays on — calling hooks
      // conditionally is a real bug in tests too. (set-state-in-effect and
      // incompatible-library are off globally, so they aren't repeated here.)
      'react-hooks/globals': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  }
);
