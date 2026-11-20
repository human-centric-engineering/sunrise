/**
 * Tests: the no-literal-JSX-text rule on the screens moved onto the string
 * catalogue (§138 t-1073).
 *
 * Runs the REAL block from `eslint.config.mjs` (its `files` and its rule
 * options) through ESLint's `Linter`, so a change to either fails here. Only
 * the parser and plugin harness are rebuilt.
 *
 * @see eslint.config.mjs
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import reactPlugin from 'eslint-plugin-react';
import tseslint from 'typescript-eslint';

interface FlatConfigBlock {
  files?: string[];
  rules?: Record<string, unknown>;
}

let block: FlatConfigBlock;

beforeAll(async () => {
  const mod = (await import('@/eslint.config.mjs')) as { default: FlatConfigBlock[] };
  const found = mod.default.find((c) => c.rules?.['react/jsx-no-literals'] !== undefined);
  if (!found) throw new Error('No flat-config block sets react/jsx-no-literals');
  block = found;
});

/** Messages from the catalogue rule for `code` linted as `filePath`. */
function lint(code: string, filePath: string): Linter.LintMessage[] {
  const linter = new Linter();
  return linter.verify(
    code,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tseslint.parser,
          parserOptions: { ecmaFeatures: { jsx: true } },
        },
        plugins: { react: reactPlugin },
      },
      { files: block.files, rules: block.rules as Linter.RulesRecord },
    ],
    filePath
  );
}

const LITERAL = `export function A() { return <p>Welcome back</p>; }`;

describe('catalogue screens: no literal JSX text', () => {
  it.each([
    'app/(auth)/login/page.tsx',
    'app/(public)/about/page.tsx',
    'app/(protected)/settings/page.tsx',
    'app/not-found.tsx',
    'components/forms/login-form.tsx',
    'components/layouts/public-header.tsx',
    'components/waitlist/waitlist-form.tsx',
    'components/theme-toggle.tsx',
  ])('rejects English written into the JSX of %s', (filePath) => {
    const messages = lint(LITERAL, filePath);

    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('react/jsx-no-literals');
  });

  it('rejects a string wrapped in braces, not just bare text', () => {
    const messages = lint(
      `export function A() { return <p>{'Welcome back'}</p>; }`,
      'components/auth/x.tsx'
    );

    expect(messages.map((m) => m.ruleId)).toEqual(['react/jsx-no-literals']);
  });

  it('accepts text from the catalogue, separators, and props', () => {
    const messages = lint(
      `export function A({ t }: { t: (k: string) => string }) {
        return <p className="text-sm" aria-hidden="true">{t('welcome')} · {t('back')}</p>;
      }`,
      'components/auth/x.tsx'
    );

    expect(messages).toEqual([]);
  });

  it.each([
    'components/admin/orchestration/x.tsx',
    'app/admin/page.tsx',
    'app/global-error.tsx',
    'components/app/x.tsx',
  ])('leaves %s alone (not converted, or English by design)', (filePath) => {
    expect(lint(LITERAL, filePath)).toEqual([]);
  });
});
