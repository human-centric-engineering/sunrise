/**
 * Unit Tests: stripEmbeddingPrefix
 *
 * @see lib/orchestration/utils/strip-embedding-prefix.ts
 */

import { describe, it, expect } from 'vitest';

import { stripEmbeddingPrefix } from '@/lib/orchestration/utils/strip-embedding-prefix';

describe('stripEmbeddingPrefix', () => {
  it('strips "PatternName — SectionName\\n\\n" prefix', () => {
    const input = 'Prompt Chaining — How It Works\n\nThe chain pattern connects steps in sequence.';
    expect(stripEmbeddingPrefix(input)).toBe('The chain pattern connects steps in sequence.');
  });

  it('strips "PatternName\\n\\n" prefix (no dash)', () => {
    const input = 'Prompt Chaining\n\nOverview of the pattern.';
    expect(stripEmbeddingPrefix(input)).toBe('Overview of the pattern.');
  });

  it('returns content unchanged when no prefix matches', () => {
    const input = 'Just some content without a prefix.';
    expect(stripEmbeddingPrefix(input)).toBe('Just some content without a prefix.');
  });

  it('returns empty string unchanged', () => {
    expect(stripEmbeddingPrefix('')).toBe('');
  });

  it('preserves multi-paragraph content after prefix', () => {
    const input = 'Pattern Name — Section\n\nFirst paragraph.\n\nSecond paragraph.';
    expect(stripEmbeddingPrefix(input)).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('handles prefix with special characters in pattern name', () => {
    const input = 'Pattern #14 (RAG) — TL;DR Summary\n\nRetrieve relevant context.';
    expect(stripEmbeddingPrefix(input)).toBe('Retrieve relevant context.');
  });
});
