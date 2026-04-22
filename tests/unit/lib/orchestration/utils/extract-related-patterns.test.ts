/**
 * extractRelatedPatterns utility tests
 *
 * @see lib/orchestration/utils/extract-related-patterns.ts
 */

import { describe, it, expect } from 'vitest';

import { extractRelatedPatterns } from '@/lib/orchestration/utils/extract-related-patterns';
import type { AiKnowledgeChunk } from '@/types/orchestration';

function makeChunk(content: string, patternNumber = 1): AiKnowledgeChunk {
  return {
    id: 'chunk-1',
    chunkKey: 'test-chunk',
    documentId: 'doc-1',
    content,
    embedding: null,
    chunkType: 'pattern_section',
    patternNumber,
    patternName: 'Test Pattern',
    category: 'agent',
    section: 'overview',
    keywords: null,
    estimatedTokens: 100,
    embeddingModel: null,
    embeddingProvider: null,
    embeddedAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  } as AiKnowledgeChunk;
}

describe('extractRelatedPatterns', () => {
  it('extracts "Pattern N" references', () => {
    const chunks = [makeChunk('See Pattern 2 for routing and Pattern 3 for parallelism.')];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result).toEqual([
      { number: 2, name: null },
      { number: 3, name: null },
    ]);
  });

  it('extracts "Pattern #N" references', () => {
    const chunks = [makeChunk('Refer to Pattern #14 for details.')];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result).toEqual([{ number: 14, name: null }]);
  });

  it('extracts name from parenthetical', () => {
    const chunks = [makeChunk('Use Pattern 2 (Routing) and Pattern 5 (Tool Use).')];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result).toEqual([
      { number: 2, name: 'Routing' },
      { number: 5, name: 'Tool Use' },
    ]);
  });

  it('excludes current pattern number', () => {
    const chunks = [makeChunk('This builds on Pattern 1 and Pattern 3.', 1)];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result).toEqual([{ number: 3, name: null }]);
  });

  it('deduplicates across chunks', () => {
    const chunks = [
      makeChunk('See Pattern 2 (Routing) for branching.'),
      makeChunk('Pattern 2 is also useful here.'),
    ];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result).toEqual([{ number: 2, name: 'Routing' }]);
  });

  it('sorts by pattern number', () => {
    const chunks = [makeChunk('Pattern 14, Pattern 3, Pattern 6.')];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result.map((r) => r.number)).toEqual([3, 6, 14]);
  });

  it('returns empty array when no cross-references', () => {
    const chunks = [makeChunk('This pattern is self-contained.')];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result).toEqual([]);
  });

  it('handles lowercase "pattern"', () => {
    const chunks = [makeChunk('See pattern 5 for tool use.')];
    const result = extractRelatedPatterns(chunks, 1);

    expect(result).toEqual([{ number: 5, name: null }]);
  });

  it('returns empty array for empty chunks', () => {
    const result = extractRelatedPatterns([], 1);
    expect(result).toEqual([]);
  });

  it('resolves names from patternNames map when parenthetical is missing', () => {
    const chunks = [makeChunk('See Pattern 2 and Pattern 5 for details.')];
    const names = new Map([
      [2, 'Routing'],
      [5, 'Tool Use'],
    ]);
    const result = extractRelatedPatterns(chunks, 1, names);

    expect(result).toEqual([
      { number: 2, name: 'Routing' },
      { number: 5, name: 'Tool Use' },
    ]);
  });

  it('prefers parenthetical name over patternNames map', () => {
    const chunks = [makeChunk('See Pattern 2 (Branching) for details.')];
    const names = new Map([[2, 'Routing']]);
    const result = extractRelatedPatterns(chunks, 1, names);

    expect(result).toEqual([{ number: 2, name: 'Branching' }]);
  });
});
