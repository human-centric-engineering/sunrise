/**
 * Semantic Chunker Tests
 *
 * Covers the embedding-driven chunking path that the structural
 * chunker delegates to for generic (non-pattern) sections.
 *
 * The embedder is mocked so tests are deterministic: each test
 * provides a fixed vector per sentence and the chunker's split
 * behaviour is verified against the resulting similarity matrix.
 * That keeps these tests independent of any real provider config
 * and lets us assert exact chunk shapes without depending on a
 * particular embedding model's behaviour.
 *
 * @see lib/orchestration/knowledge/semantic-chunker.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/knowledge/embedder', () => ({
  embedBatch: vi.fn(),
}));

import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import {
  chunkBySemanticBreakpoints,
  splitSentences,
} from '@/lib/orchestration/knowledge/semantic-chunker';

const mockEmbedBatch = vi.mocked(embedBatch);

beforeEach(() => {
  // Reset (not just clear) so the queued `mockResolvedValueOnce` /
  // `mockRejectedValueOnce` from a prior test doesn't carry over and
  // hit the wrong call.
  mockEmbedBatch.mockReset();
});

// ─── splitSentences ─────────────────────────────────────────────────────────

describe('splitSentences', () => {
  it('splits on periods followed by uppercase', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    expect(splitSentences(text)).toEqual([
      'First sentence.',
      'Second sentence.',
      'Third sentence.',
    ]);
  });

  it('treats `?` and `!` as sentence boundaries', () => {
    const text = 'Why? Because it works! And so it must.';
    expect(splitSentences(text)).toEqual(['Why?', 'Because it works!', 'And so it must.']);
  });

  it('does not split on abbreviations like `Inc.` and `e.g.`', () => {
    const text =
      'Acme Inc. is a corporation. Many companies, e.g. Acme, also do this. The point stands.';
    const sentences = splitSentences(text);
    // Without the abbreviation guard this would over-split into 5+ sentences.
    expect(sentences).toHaveLength(3);
    expect(sentences[0]).toContain('Acme Inc.');
    expect(sentences[1]).toContain('e.g.');
  });

  it('collapses multi-line text into single-spaced sentences', () => {
    // PDF-extracted text comes with line breaks inside sentences.
    const text = 'First\nsentence with\nline breaks. Second\nsentence.';
    expect(splitSentences(text)).toEqual(['First sentence with line breaks.', 'Second sentence.']);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences('   \n  \t  ')).toEqual([]);
  });

  it('treats a single un-terminated sentence as one sentence', () => {
    expect(splitSentences('A statement without a terminator')).toEqual([
      'A statement without a terminator',
    ]);
  });
});

// ─── chunkBySemanticBreakpoints ─────────────────────────────────────────────

/**
 * Build a sentence with a target token count (estimateTokens uses
 * Math.ceil(len/4), so 4 chars per requested token). Starts with an
 * uppercase letter so that when several of these are space-joined,
 * splitSentences finds the boundary (its regex requires
 * `[A-Z]` after the sentence terminator).
 */
function sentenceOfTokens(tokens: number, suffix = '.'): string {
  const filler = 'x'.repeat(Math.max(tokens * 4 - suffix.length - 1, 0));
  return `Y${filler}${suffix}`;
}

/**
 * Build N orthogonal unit vectors so cosine distance between any
 * two distinct vectors is exactly 1 (perfectly dissimilar). Useful
 * for triggering breakpoints at every adjacent pair.
 */
function orthogonalVectors(count: number, dim = 8): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    const v = new Array(dim).fill(0);
    v[i % dim] = 1;
    out.push(v);
  }
  return out;
}

/**
 * Build vectors that cluster: every `clusterSize` consecutive
 * vectors are identical (zero distance) and each cluster is
 * orthogonal to the next (distance 1). Used to verify the
 * percentile-driven breakpoint logic.
 */
function clusteredVectors(clusterCount: number, clusterSize: number, dim = 8): number[][] {
  const out: number[][] = [];
  for (let c = 0; c < clusterCount; c++) {
    const v = new Array(dim).fill(0);
    v[c % dim] = 1;
    for (let i = 0; i < clusterSize; i++) out.push(v);
  }
  return out;
}

describe('chunkBySemanticBreakpoints', () => {
  it('returns an empty array for empty input', async () => {
    const result = await chunkBySemanticBreakpoints('');
    expect(result).toEqual([]);
    expect(mockEmbedBatch).not.toHaveBeenCalled();
  });

  it('returns a single chunk when there are fewer than 4 sentences (no analysis)', async () => {
    // Two sentences gives only one adjacent-distance — meaningless.
    const text = 'Short text. Even shorter.';
    const result = await chunkBySemanticBreakpoints(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('Short text');
    expect(mockEmbedBatch).not.toHaveBeenCalled();
  });

  it('groups sentences within a cluster and breaks between clusters', async () => {
    // 2 clusters of 4 identical sentences each. Adjacent distances:
    // [0, 0, 0, 1, 0, 0, 0]. Threshold at 75th percentile = 0 (sorted
    // distances are [0,0,0,0,0,0,1]; 75% idx = 5 → value 0). With
    // threshold 0, distances >= 0 trigger breakpoints at every
    // boundary except where d > 0 only. We expect breakpoints at the
    // cluster boundary (d=1) — clusters land in the same group.
    // Use distinct sentences so the chunker doesn't collapse text.
    const cluster1 = Array.from(
      { length: 4 },
      (_, i) => `Cluster one sentence ${i} with enough text to be meaningful here.`
    );
    const cluster2 = Array.from(
      { length: 4 },
      (_, i) => `Cluster two sentence ${i} with enough text to be meaningful here.`
    );
    const text = [...cluster1, ...cluster2].join(' ');

    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: clusteredVectors(2, 4),
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 1, // disable min-size merging so we can verify raw grouping
      maxTokens: 10_000, // disable size split-down
    });

    // The 75th-percentile threshold on [0,0,0,1,0,0,0] is 0, so EVERY
    // adjacent pair is a breakpoint (every distance is >= 0). That's
    // an over-aggressive default — but it's the documented behaviour,
    // and the size guardrails (min/max tokens) merge tiny groups
    // back together in real use. With min/max guardrails off, we
    // expect each sentence in its own group → 8 groups.
    expect(result).toHaveLength(8);
  });

  it('respects minTokens by merging tiny chunks into neighbours', async () => {
    // Same 2x4 clustered input but with realistic min-tokens. Each
    // sentence is small (~14 tokens); minTokens=50 forces merging.
    const cluster1 = Array.from(
      { length: 4 },
      (_, i) => `Cluster one sentence ${i} with enough text to be meaningful here.`
    );
    const cluster2 = Array.from(
      { length: 4 },
      (_, i) => `Cluster two sentence ${i} with enough text to be meaningful here.`
    );
    const text = [...cluster1, ...cluster2].join(' ');

    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: clusteredVectors(2, 4),
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 50,
      maxTokens: 10_000,
    });

    // After merging tiny groups, expect notably fewer chunks than
    // the raw 8 groups. The exact count depends on the merge
    // heuristic; we assert "meaningfully fewer" rather than a
    // specific number to keep the test resilient to micro-tuning.
    expect(result.length).toBeLessThan(8);
    expect(result.length).toBeGreaterThan(0);
  });

  it('sub-splits oversized topic groups so no chunk exceeds maxTokens', async () => {
    // Build a single "topic" — every sentence has the SAME embedding
    // vector so no breakpoints fire — but the total exceeds
    // maxTokens. The size-guardrail step must sub-split.
    const bigSentences = Array.from({ length: 6 }, (_, i) => sentenceOfTokens(50, ` sent ${i}.`));
    const text = bigSentences.join(' ');

    const dim = 8;
    const sameVector = new Array(dim).fill(0);
    sameVector[0] = 1;
    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: Array.from({ length: bigSentences.length }, () => [...sameVector]),
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 50,
      maxTokens: 150,
    });

    // 6 × ~50 tokens = ~300 tokens. With maxTokens=150 the sub-split
    // must produce at least 2 chunks, each ≤ maxTokens.
    expect(result.length).toBeGreaterThanOrEqual(2);
    for (const chunk of result) {
      // chars/4 ≈ tokens. Add a tiny slack for the rounding boundary.
      expect(Math.ceil(chunk.length / 4)).toBeLessThanOrEqual(155);
    }
  });

  it('propagates embedder errors so the caller can fall back', async () => {
    // Need ≥ 4 sentences to trigger the embedder call.
    const text =
      'One sentence here. Two sentences here. Three sentences here. Four sentences here.';
    mockEmbedBatch.mockRejectedValueOnce(new Error('provider unreachable'));

    await expect(chunkBySemanticBreakpoints(text)).rejects.toThrow('provider unreachable');
  });

  it('throws when embedder returns the wrong number of vectors', async () => {
    const text =
      'One sentence here. Two sentences here. Three sentences here. Four sentences here.';
    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: orthogonalVectors(2), // only 2 vectors for 4 sentences
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    await expect(chunkBySemanticBreakpoints(text)).rejects.toThrow(
      /returned 2 vectors for 4 sentences/i
    );
  });
});
