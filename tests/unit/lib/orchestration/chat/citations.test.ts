/**
 * Tests for `lib/orchestration/chat/citations.ts`.
 *
 * Covers the citation extraction helper used by the streaming chat
 * handler. The contract: citation-producing capabilities get their
 * result items augmented with a monotonic `marker` and a structured
 * Citation envelope is returned. Non-citation tools and failure
 * envelopes pass through unchanged.
 */

import { describe, expect, it } from 'vitest';
import { extractCitations } from '@/lib/orchestration/chat/citations';

function searchResult(items: Array<Record<string, unknown>>) {
  return {
    success: true,
    data: { results: items },
  };
}

const baseItem = {
  chunkId: 'chunk-1',
  documentId: 'doc-1',
  documentName: 'Tenancy Guide',
  content: 'The deposit must be protected within 30 days.',
  patternNumber: null,
  patternName: null,
  section: 'Page 12',
  similarity: 0.91,
};

describe('extractCitations', () => {
  it('passes through unchanged for non-citation-producing capabilities', () => {
    const result = { success: true, data: { foo: 'bar' } };
    const output = extractCitations('send_email', result, 1);
    expect(output.citations).toEqual([]);
    expect(output.augmentedResult).toBe(result);
    expect(output.nextMarker).toBe(1);
  });

  it('passes through unchanged for failure envelopes', () => {
    const result = { success: false, error: { code: 'fail', message: 'nope' } };
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations).toEqual([]);
    expect(output.augmentedResult).toBe(result);
    expect(output.nextMarker).toBe(1);
  });

  it('passes through unchanged when shape does not match', () => {
    const result = { success: true, data: { unrelated: true } };
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations).toEqual([]);
    expect(output.augmentedResult).toBe(result);
    expect(output.nextMarker).toBe(1);
  });

  it('assigns monotonic markers from the start counter', () => {
    const result = searchResult([
      { ...baseItem, chunkId: 'a' },
      { ...baseItem, chunkId: 'b' },
    ]);
    const output = extractCitations('search_knowledge_base', result, 3);
    expect(output.citations.map((c) => c.marker)).toEqual([3, 4]);
    expect(output.nextMarker).toBe(5);
  });

  it('augments result items with a `marker` field that mirrors the citation', () => {
    const result = searchResult([{ ...baseItem }]);
    const output = extractCitations('search_knowledge_base', result, 1);
    const augmented = output.augmentedResult as { data: { results: Array<{ marker: number }> } };
    expect(augmented.data.results[0].marker).toBe(1);
    expect(output.citations[0].marker).toBe(1);
  });

  it('truncates long excerpts and appends an ellipsis', () => {
    const longContent = 'x'.repeat(500);
    const result = searchResult([{ ...baseItem, content: longContent }]);
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations[0].excerpt.length).toBeLessThan(longContent.length);
    expect(output.citations[0].excerpt.endsWith('…')).toBe(true);
  });

  it('preserves short excerpts unchanged', () => {
    const result = searchResult([{ ...baseItem, content: 'short' }]);
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations[0].excerpt).toBe('short');
  });

  it('forwards hybrid scores when present', () => {
    const result = searchResult([
      { ...baseItem, vectorScore: 0.85, keywordScore: 0.32, finalScore: 1.17 },
    ]);
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations[0].vectorScore).toBe(0.85);
    expect(output.citations[0].keywordScore).toBe(0.32);
    expect(output.citations[0].finalScore).toBe(1.17);
  });

  it('omits hybrid score keys entirely when not present', () => {
    const result = searchResult([{ ...baseItem }]);
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations[0]).not.toHaveProperty('vectorScore');
    expect(output.citations[0]).not.toHaveProperty('keywordScore');
    expect(output.citations[0]).not.toHaveProperty('finalScore');
  });

  it('skips items that fail the shape check', () => {
    const result = searchResult([
      { ...baseItem },
      { chunkId: 42, documentId: null }, // malformed
      { ...baseItem, chunkId: 'b' },
    ]);
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations.map((c) => c.chunkId)).toEqual(['chunk-1', 'b']);
    expect(output.nextMarker).toBe(3);
  });

  it('falls back to null documentName when missing on the source item', () => {
    const item = { ...baseItem, documentName: undefined };
    const result = searchResult([item]);
    const output = extractCitations('search_knowledge_base', result, 1);
    expect(output.citations[0].documentName).toBe(null);
  });

  it('coalesces missing optional fields to null to match the Citation type', () => {
    // Type-guard only enforces load-bearing fields; missing optional
    // fields must not leak through as `undefined`.
    const item = {
      chunkId: 'sparse-1',
      documentId: 'doc-2',
      content: 'minimal item',
      similarity: 0.8,
      // patternNumber, patternName, section, documentName all omitted
    };
    const result = searchResult([item]);
    const output = extractCitations('search_knowledge_base', result, 1);
    const c = output.citations[0];
    expect(c.documentName).toBe(null);
    expect(c.section).toBe(null);
    expect(c.patternNumber).toBe(null);
    expect(c.patternName).toBe(null);
  });
});
