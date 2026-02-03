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
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
          allowConciseArrowFunctionExpressionsStartingWithVoid: false,
          allowFunctionsWithoutTypeParameters: false,
          allowedNames: [],
        },
      ],
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

      // Custom rules
      'no-console': 'error',
      'react/react-in-jsx-scope': 'off', // Not needed with Next.js
      'react/prop-types': 'off', // Using TypeScript
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
      // See: .instructions/ROOT-CAUSE-ANALYSIS-TESTING-CYCLE.md
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
      '@typescript-eslint/explicit-function-return-type': 'off',
    },
  }
);
