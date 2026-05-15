/**
 * isMarkdown — heuristic markdown detector.
 *
 * Each branch in the source corresponds to one markdown signal. Tests are
 * organised by branch so a failure points directly at the line responsible.
 *
 * @see lib/utils/is-markdown.ts
 */

import { describe, expect, it } from 'vitest';
import { isMarkdown } from '@/lib/utils/is-markdown';

describe('isMarkdown', () => {
  describe('non-string input', () => {
    it('returns false for non-string values', () => {
      expect(isMarkdown(null)).toBe(false);
      expect(isMarkdown(undefined)).toBe(false);
      expect(isMarkdown(42)).toBe(false);
      expect(isMarkdown({})).toBe(false);
      expect(isMarkdown([])).toBe(false);
      expect(isMarkdown(true)).toBe(false);
    });

    it('returns false for empty / whitespace-only strings', () => {
      expect(isMarkdown('')).toBe(false);
      expect(isMarkdown('   ')).toBe(false);
      expect(isMarkdown('\n\n')).toBe(false);
    });
  });

  describe('positive signals', () => {
    it('detects fenced code blocks', () => {
      expect(isMarkdown('```\ncode\n```')).toBe(true);
      expect(isMarkdown('```ts\nconst x = 1;\n```')).toBe(true);
    });

    it('detects ATX headings', () => {
      expect(isMarkdown('# Heading')).toBe(true);
      expect(isMarkdown('## Sub')).toBe(true);
      expect(isMarkdown('###### Smallest')).toBe(true);
      // 7 # is not an ATX heading — must NOT match.
      expect(isMarkdown('####### Too many')).toBe(false);
    });

    it('detects bullet and numbered list items', () => {
      expect(isMarkdown('- item')).toBe(true);
      expect(isMarkdown('* item')).toBe(true);
      expect(isMarkdown('+ item')).toBe(true);
      expect(isMarkdown('1. first')).toBe(true);
      expect(isMarkdown('  3. indented numbered')).toBe(true);
    });

    it('detects blockquotes', () => {
      expect(isMarkdown('> quoted text')).toBe(true);
    });

    it('detects inline links', () => {
      expect(isMarkdown('See [the docs](https://example.com).')).toBe(true);
    });

    it('detects bold emphasis', () => {
      expect(isMarkdown('text with **bold** word')).toBe(true);
      expect(isMarkdown('underscored __bold__ here')).toBe(true);
    });

    it('detects inline code spans', () => {
      expect(isMarkdown('use `someFn()` to invoke')).toBe(true);
    });

    it('detects GFM tables', () => {
      const table = `| col a | col b |\n| --- | --- |\n| 1 | 2 |`;
      expect(isMarkdown(table)).toBe(true);
    });
  });

  describe('negative signals', () => {
    it('does not match a single stray backtick', () => {
      expect(isMarkdown('cost was 5 ` something')).toBe(false);
    });

    it('does not match a bare hash without space', () => {
      // ATX heading rule requires `#{1,6}\s+\S`.
      expect(isMarkdown('#nope')).toBe(false);
    });

    it('does not match a bare > without space', () => {
      expect(isMarkdown('>noquote')).toBe(false);
    });

    it('does not flag plain prose without markdown signals', () => {
      expect(isMarkdown('Just some ordinary text without any formatting.')).toBe(false);
    });

    it('does not match a single asterisk pair separated by whitespace', () => {
      // ** with a leading space is not bold.
      expect(isMarkdown('not ** bold** here')).toBe(false);
    });
  });

  describe('type predicate', () => {
    it('narrows to string when true', () => {
      const v: unknown = '# hi';
      if (isMarkdown(v)) {
        // Compile-time check: v is string here. Run-time: it's a string.
        expect(typeof v).toBe('string');
      } else {
        throw new Error('expected positive');
      }
    });
  });
});
