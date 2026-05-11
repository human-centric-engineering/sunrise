/**
 * Semantic chunker — splits text at topic boundaries detected via
 * embedding-similarity drops between adjacent sentences.
 *
 * Why bother:
 *   Structural chunkers (paragraph / line / sentence / char-window) split
 *   at syntactic boundaries that *correlate with* meaning in well-marked-up
 *   text (markdown with `##` headings) but fall apart on PDF-extracted
 *   prose, raw transcripts, or anything where the author didn't insert
 *   blank-line paragraph breaks. The result is chunks that begin
 *   mid-thought and end mid-sentence — embeddings pollute, retrieval gets
 *   the wrong piece.
 *
 *   Semantic chunking instead computes one embedding per sentence,
 *   measures cosine distance between *adjacent* sentences in the original
 *   order, and declares a chunk boundary wherever that distance is in the
 *   top quartile of all observed distances. Two sentences that talk about
 *   the same topic land in the same chunk; a sentence that pivots to a
 *   new topic starts a new one. This is the same heuristic LangChain's
 *   `SemanticChunker` and llama_index's `SemanticSplitter` use.
 *
 * Cost:
 *   N embedding API calls for a document with N sentences. For a typical
 *   PDF that's a few hundred calls of ~0.01k tokens each — pennies with
 *   `text-embedding-3-small`, free with local Ollama or Voyage's free
 *   tier. Each final chunk still gets its own storage embedding so
 *   retrieval-time vectors represent the full chunk text, not an
 *   average. Net: ingest cost roughly doubles versus structural chunking.
 *
 * Fallback:
 *   The caller is expected to fall back to the structural splitter when
 *   this throws or returns an empty array — e.g. provider unreachable,
 *   text too short to be worth analysing, sentence segmentation produced
 *   nothing. Failure here must never block a document from being
 *   ingested; semantic chunking is a quality upgrade, not a hard
 *   dependency.
 */

import { logger } from '@/lib/logging';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';

/**
 * Rough English token estimate — mirrors `chunker.ts#estimateTokens` so
 * MIN/MAX thresholds stay coherent across the two splitters.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SemanticChunkOptions {
  /**
   * Lower bound on chunk size in tokens. Below this, neighbouring
   * chunks are merged. Default mirrors the structural chunker.
   */
  minTokens?: number;
  /**
   * Upper bound on chunk size in tokens. Above this, a chunk is
   * sub-split via single-sentence groups. Default mirrors the
   * structural chunker.
   */
  maxTokens?: number;
  /**
   * Percentile threshold for declaring a breakpoint. 75 means "split
   * at the largest 25 % of similarity-distance jumps observed in this
   * document". Higher = fewer breakpoints / larger chunks; lower =
   * more breakpoints / smaller chunks. 75 is the LangChain default
   * and matches what we see giving sensible boundaries on the
   * whitepaper-style inputs.
   */
  breakpointPercentile?: number;
}

interface ResolvedOptions {
  minTokens: number;
  maxTokens: number;
  breakpointPercentile: number;
}

const DEFAULTS: ResolvedOptions = {
  minTokens: 50,
  maxTokens: 800,
  breakpointPercentile: 75,
};

/**
 * Tiny fixed list of common abbreviations whose trailing period must
 * NOT be treated as a sentence boundary. Far from exhaustive but
 * covers the abbreviations most likely to show up in business and
 * technical prose; missing entries cause over-splitting (a single
 * "sentence" gets cut at the abbreviation), which the size
 * normalisation step recovers from anyway.
 */
const ABBREVIATIONS = new Set([
  'Mr.',
  'Mrs.',
  'Ms.',
  'Dr.',
  'Prof.',
  'Sr.',
  'Jr.',
  'Inc.',
  'Ltd.',
  'Co.',
  'Corp.',
  'vs.',
  'e.g.',
  'i.e.',
  'etc.',
  'No.',
  'Fig.',
  'cf.',
  'al.',
]);

/**
 * Split text into sentences via a regex that breaks on `. ` / `! ` /
 * `? ` / newline-boundaries when followed by an uppercase letter (or
 * end of input). Filters out matches whose terminating word is in
 * the abbreviation list so `Inc.` / `e.g.` don't break sentences.
 *
 * This is intentionally simple — no NLP library — because the
 * downstream similarity check is forgiving of imperfect segmentation.
 * Over-splitting hurts a little; missed splits hurt more, but
 * structural fallback catches anything that ends up too large.
 */
export function splitSentences(text: string): string[] {
  // Normalise whitespace so multi-line PDF extraction collapses to
  // single-space prose. Without this, the regex below sees `.\n` and
  // treats every line break as a non-boundary.
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return [];

  const sentences: string[] = [];
  let cursor = 0;
  // Match a sentence-ending punctuation followed by whitespace and
  // either an uppercase letter or end of input. Captures the
  // preceding "word" so we can reject abbreviations.
  const re = /(\S+[.!?])(\s+)(?=[A-Z"'([]|$)/g;

  let m: RegExpExecArray | null;
  while ((m = re.exec(collapsed)) !== null) {
    const word = m[1];
    if (ABBREVIATIONS.has(word)) continue;
    const endIndex = m.index + m[1].length;
    const sentence = collapsed.slice(cursor, endIndex).trim();
    if (sentence.length > 0) sentences.push(sentence);
    cursor = endIndex + m[2].length;
  }
  const tail = collapsed.slice(cursor).trim();
  if (tail.length > 0) sentences.push(tail);

  return sentences;
}

/**
 * Cosine distance between two same-length vectors. Returns 1 (max
 * distance) when either vector is the zero vector — we don't want a
 * zero-magnitude embedding to look "similar" to anything.
 */
function cosineDistance(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 1;
  return 1 - dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Compute the Nth-percentile value of a numeric array using linear
 * interpolation. p=75 returns the value such that 75 % of the
 * distances fall at-or-below it.
 */
function percentile(values: ReadonlyArray<number>, p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = ((p / 100) * (sorted.length - 1)) | 0;
  return sorted[idx];
}

/**
 * After breakpoint detection we have an array of sentence groups
 * where each group is one coherent topic. Some groups may be tiny
 * (a one-sentence topic) or huge (a topic that ran long). This
 * pass enforces min/max token bounds by merging small consecutive
 * groups and sub-splitting oversized ones at sentence boundaries.
 */
function normaliseGroups(
  groups: ReadonlyArray<ReadonlyArray<string>>,
  opts: ResolvedOptions
): string[][] {
  const out: string[][] = [];
  let buffer: string[] = [];

  const flushBuffer = (): void => {
    if (buffer.length > 0) {
      out.push(buffer);
      buffer = [];
    }
  };

  for (const group of groups) {
    const groupTokens = estimateTokens(group.join(' '));

    if (groupTokens > opts.maxTokens) {
      flushBuffer();
      // Sub-split: accumulate sentences until just under maxTokens.
      let sub: string[] = [];
      let subTokens = 0;
      for (const sentence of group) {
        const sentTokens = estimateTokens(sentence);
        if (subTokens + sentTokens > opts.maxTokens && sub.length > 0) {
          out.push(sub);
          sub = [sentence];
          subTokens = sentTokens;
        } else {
          sub.push(sentence);
          subTokens += sentTokens;
        }
      }
      if (sub.length > 0) out.push(sub);
      continue;
    }

    if (groupTokens < opts.minTokens) {
      // Stash into buffer for merging with the next group.
      buffer.push(...group);
      const bufferTokens = estimateTokens(buffer.join(' '));
      if (bufferTokens >= opts.minTokens) flushBuffer();
      continue;
    }

    // Sized correctly — flush any pending buffer onto this group,
    // then emit. This keeps a tiny preceding topic glued to the
    // next coherent one rather than stranding it as a micro-chunk.
    if (buffer.length > 0) {
      buffer.push(...group);
      flushBuffer();
    } else {
      out.push([...group]);
    }
  }

  flushBuffer();
  return out;
}

/**
 * Split `text` into topic-coherent chunks via embedding-similarity
 * breakpoint detection. Returns an array of chunk text bodies — the
 * caller wraps each body with whatever header / metadata applies in
 * its context.
 *
 * Throws if the embedding provider is unreachable; callers should
 * catch and fall back to the structural splitter. Returns the full
 * text as a single chunk when there are too few sentences (< 4) to
 * estimate a meaningful breakpoint distribution.
 */
export async function chunkBySemanticBreakpoints(
  text: string,
  options: SemanticChunkOptions = {}
): Promise<string[]> {
  const opts: ResolvedOptions = { ...DEFAULTS, ...options };

  const sentences = splitSentences(text);
  if (sentences.length === 0) return [];
  if (sentences.length < 4) {
    // Below 4 sentences there are at most 2 adjacent-distance pairs;
    // a percentile on that is meaningless. Treat as one chunk.
    logger.debug('Semantic chunker: too few sentences to analyse — returning single chunk', {
      sentenceCount: sentences.length,
    });
    return [text.trim()];
  }

  // Embed every sentence in one batched call. embedBatch handles
  // batching + provider rate limiting internally.
  const { embeddings } = await embedBatch(sentences, undefined, 'document');
  if (embeddings.length !== sentences.length) {
    throw new Error(
      `Semantic chunker: embedder returned ${embeddings.length} vectors for ${sentences.length} sentences`
    );
  }

  // Cosine distance between each adjacent sentence pair.
  const distances: number[] = [];
  for (let i = 0; i < embeddings.length - 1; i++) {
    distances.push(cosineDistance(embeddings[i], embeddings[i + 1]));
  }

  // Threshold = Nth percentile of observed distances. Distances at
  // or above this trigger a topic boundary.
  const threshold = percentile(distances, opts.breakpointPercentile);

  // Group sentences between breakpoints. distances[i] is the gap
  // between sentence[i] and sentence[i+1]; a breakpoint at i means
  // sentence[i+1] starts a new group.
  const groups: string[][] = [];
  let current: string[] = [sentences[0]];
  for (let i = 0; i < distances.length; i++) {
    if (distances[i] >= threshold) {
      groups.push(current);
      current = [sentences[i + 1]];
    } else {
      current.push(sentences[i + 1]);
    }
  }
  groups.push(current);

  // Enforce size guardrails: merge tiny groups, sub-split oversized ones.
  const normalised = normaliseGroups(groups, opts);

  const bodies = normalised.map((group) => group.join(' ').trim()).filter((s) => s.length > 0);

  logger.info('Semantic chunker produced chunks', {
    sentenceCount: sentences.length,
    rawGroups: groups.length,
    finalChunks: bodies.length,
    breakpointPercentile: opts.breakpointPercentile,
    thresholdDistance: Number(threshold.toFixed(4)),
  });

  return bodies;
}
