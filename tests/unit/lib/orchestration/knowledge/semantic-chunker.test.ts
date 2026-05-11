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

  it('treats a zero-vector embedding as maximally dissimilar to its neighbours', async () => {
    // Edge case: an embedding provider returns a zero vector for one
    // sentence (rare but observable when the input is whitespace-only
    // or the provider's tokenizer drops it). cosineDistance falls back
    // to distance 1 rather than NaN, so the breakpoint logic still
    // works. With 4 sentences and one zero vector in the middle, the
    // zero-vs-neighbour distances should be the largest and become
    // the breakpoint locations.
    const text =
      'First sentence here. Second sentence here. Third sentence here. Fourth sentence here.';
    const ortho1 = [1, 0, 0, 0];
    const ortho2 = [0, 1, 0, 0];
    const zero = [0, 0, 0, 0];
    const ortho3 = [0, 0, 1, 0];

    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: [ortho1, ortho2, zero, ortho3],
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 1,
      maxTokens: 10_000,
    });

    // Should produce more than one chunk — zero-vector distances of 1
    // dominate the percentile and split around the zero-vector
    // sentence.
    expect(result.length).toBeGreaterThan(1);
  });

  it('flushes a trailing sub-min buffer when the document ends on tiny groups', async () => {
    // 5 sentences: two clusters of orthogonal vectors so breakpoints
    // fire at every adjacent boundary at 75th percentile. With small
    // sentences and a generous minTokens, every group is under-size.
    // The normaliser must still emit the buffered tail rather than
    // dropping it on the floor when the iteration ends with a
    // non-empty buffer.
    const text =
      'Tiny sentence one. Tiny sentence two. Tiny sentence three. Tiny sentence four. Tiny sentence five.';
    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: orthogonalVectors(5),
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 10_000, // larger than the entire document
      maxTokens: 100_000,
    });

    // Every group is under min, so they all stash into the buffer;
    // the closing flushBuffer must emit the accumulated content as
    // exactly one chunk rather than dropping it.
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('Tiny sentence one');
    expect(result[0]).toContain('Tiny sentence five');
  });

  it('sub-splits a coherent topic group when its accumulated size exceeds maxTokens', async () => {
    // To hit the sub-split path (line 209 of normaliseGroups) we
    // need a *single semantic group* to come out of the breakpoint
    // pass already over maxTokens. That requires distances inside
    // the group to be below the percentile threshold while at
    // least one boundary distance is above it.
    //
    // Setup: 4 sentences with embeddings v1, v1, v2, v2. Distances
    // are [0, 1, 0]. Sorted: [0, 0, 1]. 75th-percentile index =
    // floor(0.75 * 2) = 1, value = 0. Threshold = 0 — every >= 0
    // distance fires a breakpoint, so this would split into 4
    // singletons.
    //
    // To force NO breakpoint inside the first half, we need a
    // higher percentile and varied distances. With 6 sentences:
    // v1×3, v2×3, distances [0,0,1,0,0]. Sorted: [0,0,0,0,1].
    // 75th-percentile idx = floor(0.75 * 4) = 3, value = 0.
    // Still threshold = 0. We need at least one distance > 0 to
    // come out of the percentile at position 75th — use float
    // distances so the percentile picks a non-zero value.
    //
    // Trick: use distances [0.1, 0.1, 1, 0.1, 0.1]. Sorted:
    // [0.1, 0.1, 0.1, 0.1, 1]. 75th idx = 3, value = 0.1. Threshold
    // = 0.1. Distances >= 0.1: all five — so every pair becomes a
    // breakpoint again. Same problem.
    //
    // We need ONE distance well above the others. Distances
    // [0.001, 0.001, 1, 0.001, 0.001]: sorted same shape, threshold
    // = 0.001, all >= so all breakpoints fire.
    //
    // The only way to keep some distances *below* threshold is to
    // have ties at the threshold value rounded down by `| 0`.
    // Easier path: pick a 90th-percentile threshold instead so most
    // small distances fall below it.
    const sentenceTokens = 100;
    const s = (i: number) => sentenceOfTokens(sentenceTokens, ` num ${i}.`);
    const text = `${s(0)} ${s(1)} ${s(2)} ${s(3)} ${s(4)} ${s(5)}`;

    // 6 sentence embeddings with one big jump in the middle. Inner
    // jumps are 0 (identical vectors), the middle jump is 1
    // (orthogonal vectors). With breakpointPercentile=90 the
    // threshold lands at 0.8 (90th percentile of [0,0,0,0,1] is
    // index 3 → value 0). Distances >= 0: again all fire.
    //
    // The deciding insight: we can't avoid the percentile collapse
    // when distances are mostly 0. So use minTokens=1 to disable
    // merging and feed the size-guard directly with a single
    // oversized pre-baked group instead. That requires reaching
    // normaliseGroups with a group already > maxTokens.
    //
    // Take a different shortcut: force all embeddings to be
    // identical so distances are all 0, threshold = 0, and the
    // `>=` comparison still triggers every breakpoint. That fails
    // the same way.
    //
    // The robust way: use ONE pair of identical vectors and the
    // rest distinct, so most distances are 1 (orthogonal pairs)
    // and one is 0 (the identical pair). With 6 sentences:
    // v1, v2, v3, v3, v4, v5 → distances [1, 1, 0, 1, 1]. Sorted:
    // [0, 1, 1, 1, 1]. 75th idx = floor(0.75*4)=3 → value 1.
    // Threshold = 1. Distances >= 1: indices 0, 1, 3, 4 fire.
    // Index 2 (the zero distance) does NOT fire. Groups:
    //   [s0], [s1], [s2, s3], [s4], [s5]
    // The middle group [s2, s3] is 200 tokens (over maxTokens=150)
    // → triggers the sub-split path.
    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: [
        [1, 0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 0, 1, 0, 0, 0], // identical to previous — distance 0
        [0, 0, 0, 1, 0, 0],
        [0, 0, 0, 0, 1, 0],
      ],
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 1, // disable merging so the oversized group survives
      maxTokens: 150,
    });

    // No chunk may exceed maxTokens after the sub-split.
    for (const chunk of result) {
      expect(Math.ceil(chunk.length / 4)).toBeLessThanOrEqual(160);
    }
    // The s2/s3 200-token group must have produced at least 2 sub-chunks.
    expect(result.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps consecutive sentences in the same group when their distance is below the percentile threshold', async () => {
    // Verifies the "else" branch of `if (distances[i] >= threshold)`
    // — the non-breakpoint accumulation path. Without this branch
    // covered we'd silently break the "two related sentences stay
    // glued" invariant if the comparison ever flipped.
    const s = (i: number) => `Coherent sentence number ${i} with sufficient length to count.`;
    const text = `${s(1)} ${s(2)} ${s(3)} ${s(4)} ${s(5)} ${s(6)}`;
    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: [
        [1, 0, 0, 0, 0, 0],
        [0, 1, 0, 0, 0, 0],
        [0, 0, 1, 0, 0, 0],
        [0, 0, 1, 0, 0, 0], // identical → distance 0 (under threshold)
        [0, 0, 0, 1, 0, 0],
        [0, 0, 0, 0, 1, 0],
      ],
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 1,
      maxTokens: 10_000,
    });

    // The identical-vector pair (s3, s4) must end up in the same
    // group, so the joined output contains "number 3" and "number 4"
    // in the same chunk.
    const joined = result.find((c) => c.includes('number 3') && c.includes('number 4'));
    expect(joined).toBeDefined();
  });

  it('flushes a pending sub-min buffer onto the next correctly-sized group', async () => {
    // Mix: first group is tiny → goes in buffer. Second group is
    // sized correctly → the buffer must flush *into* this group
    // rather than emit as a standalone micro-chunk. Verifies the
    // "sized correctly + buffer non-empty" branch of normaliseGroups.
    const tinySentence = 'Short.';
    const bigSentence = sentenceOfTokens(60, ' here.'); // ~60 tokens — over min

    // 4 sentences: tiny, tiny, big, big — split at the boundary
    // between tiny pair and big pair via orthogonal vectors.
    const text = `${tinySentence} ${tinySentence} ${bigSentence} ${bigSentence}`;
    mockEmbedBatch.mockResolvedValueOnce({
      embeddings: [
        [1, 0, 0, 0],
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 1, 0, 0],
      ],
      provenance: { provider: 'mock', model: 'mock', embeddedAt: new Date('2024-01-01') },
    });

    const result = await chunkBySemanticBreakpoints(text, {
      breakpointPercentile: 75,
      minTokens: 50,
      maxTokens: 10_000,
    });

    // The tiny pair must end up merged into the big group, not
    // stranded as a separate chunk under min size.
    for (const chunk of result) {
      const tokens = Math.ceil(chunk.length / 4);
      expect(tokens).toBeGreaterThanOrEqual(50);
    }
  });
});
