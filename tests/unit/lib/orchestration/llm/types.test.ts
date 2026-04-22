/**
 * Tests for `lib/orchestration/llm/types.ts`.
 *
 * The only runtime code in this module is `getTextContent()`. All other
 * exports are pure TypeScript type definitions with no runtime behaviour.
 *
 * Test Coverage:
 * - getTextContent: string passthrough
 * - getTextContent: empty string
 * - getTextContent: ContentPart[] with text parts
 * - getTextContent: ContentPart[] with no text parts (images only)
 * - getTextContent: ContentPart[] with mixed text and non-text parts
 * - getTextContent: multiple text parts concatenated
 *
 * @see lib/orchestration/llm/types.ts
 */

import { describe, expect, it } from 'vitest';
import { getTextContent } from '@/lib/orchestration/llm/types';
import type { ContentPart } from '@/lib/orchestration/llm/types';

describe('getTextContent', () => {
  describe('string input', () => {
    it('returns the string as-is', () => {
      expect(getTextContent('hello world')).toBe('hello world');
    });

    it('returns an empty string unchanged', () => {
      expect(getTextContent('')).toBe('');
    });

    it('returns strings with special characters unchanged', () => {
      const input = 'line1\nline2\ttab\u00e9';
      expect(getTextContent(input)).toBe(input);
    });
  });

  describe('ContentPart[] input', () => {
    it('returns text from a single text part', () => {
      const parts: ContentPart[] = [{ type: 'text', text: 'Hello' }];
      expect(getTextContent(parts)).toBe('Hello');
    });

    it('concatenates multiple text parts without separator', () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ];
      expect(getTextContent(parts)).toBe('Hello world');
    });

    it('returns empty string when array has no text parts (image only)', () => {
      const parts: ContentPart[] = [
        {
          type: 'image',
          source: { type: 'base64', mediaType: 'image/png', data: 'abc123' },
        },
      ];
      expect(getTextContent(parts)).toBe('');
    });

    it('extracts only text parts from a mixed text/image array', () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'Describe this: ' },
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.com/img.png' },
        },
        { type: 'text', text: 'end' },
      ];
      expect(getTextContent(parts)).toBe('Describe this: end');
    });

    it('extracts only text parts from a mixed text/document array', () => {
      const parts: ContentPart[] = [
        { type: 'text', text: 'Summarize: ' },
        {
          type: 'document',
          source: { type: 'base64', mediaType: 'application/pdf', data: 'cGRm' },
          name: 'report.pdf',
        },
      ];
      expect(getTextContent(parts)).toBe('Summarize: ');
    });

    it('returns empty string for an empty array', () => {
      expect(getTextContent([])).toBe('');
    });
  });
});
