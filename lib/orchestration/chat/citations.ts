/**
 * Citation extraction for capability results.
 *
 * The streaming chat handler calls {@link extractCitations} after every
 * capability dispatch. For citation-producing capabilities (currently
 * `search_knowledge_base`), each result item is assigned a monotonic
 * `marker` and a {@link Citation} envelope is emitted alongside an
 * augmented result that carries the marker back to:
 *
 * 1. the SSE client (so the renderer can pre-bind markers to sources),
 * 2. the persisted tool message (so the trace viewer keeps the link),
 * 3. the LLM on the next turn (so the model can cite via `[N]` syntax).
 *
 * Defensive: any capability whose slug is not in
 * {@link CITATION_PRODUCING_SLUGS}, any failure envelope, or any result
 * shape that does not match the search-knowledge-base contract is
 * passed through unchanged.
 */

import type { Citation } from '@/types/orchestration';

const EXCERPT_MAX_CHARS = 240;

const CITATION_PRODUCING_SLUGS = new Set<string>(['search_knowledge_base']);

interface SearchResultItem {
  chunkId: string;
  documentId: string;
  documentName: string | null;
  content: string;
  patternNumber: number | null;
  patternName: string | null;
  section: string | null;
  similarity: number;
  vectorScore?: number;
  keywordScore?: number;
  finalScore?: number;
}

interface CapabilityEnvelope {
  success: boolean;
  data?: unknown;
}

function isCapabilityEnvelope(value: unknown): value is CapabilityEnvelope {
  return typeof value === 'object' && value !== null && 'success' in value;
}

function isSearchData(value: unknown): value is { results: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'results' in value &&
    Array.isArray((value as { results: unknown }).results)
  );
}

function isSearchResultItem(value: unknown): value is SearchResultItem {
  if (typeof value !== 'object' || value === null) return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.chunkId === 'string' &&
    typeof o.documentId === 'string' &&
    typeof o.content === 'string' &&
    typeof o.similarity === 'number'
  );
}

function truncateExcerpt(content: string): string {
  if (content.length <= EXCERPT_MAX_CHARS) return content;
  return content.slice(0, EXCERPT_MAX_CHARS - 1).trimEnd() + '…';
}

export interface ExtractCitationsResult {
  citations: Citation[];
  augmentedResult: unknown;
  nextMarker: number;
}

/**
 * Extract citations from a capability result and augment each result
 * item with a numeric `marker` so the LLM can reference it via `[N]`.
 *
 * @param capabilitySlug Slug of the capability that produced `result`.
 * @param result The dispatcher's envelope (`{ success, data }`).
 * @param startMarker First marker number to assign (1-indexed across the turn).
 */
export function extractCitations(
  capabilitySlug: string,
  result: unknown,
  startMarker: number
): ExtractCitationsResult {
  if (!CITATION_PRODUCING_SLUGS.has(capabilitySlug)) {
    return { citations: [], augmentedResult: result, nextMarker: startMarker };
  }
  if (!isCapabilityEnvelope(result) || !result.success || !isSearchData(result.data)) {
    return { citations: [], augmentedResult: result, nextMarker: startMarker };
  }

  const newCitations: Citation[] = [];
  const augmentedItems: Array<SearchResultItem & { marker: number }> = [];
  let nextMarker = startMarker;

  for (const raw of result.data.results) {
    if (!isSearchResultItem(raw)) continue;
    const marker = nextMarker++;
    augmentedItems.push({ ...raw, marker });
    newCitations.push({
      marker,
      chunkId: raw.chunkId,
      documentId: raw.documentId,
      documentName: raw.documentName ?? null,
      section: raw.section,
      patternNumber: raw.patternNumber,
      patternName: raw.patternName,
      excerpt: truncateExcerpt(raw.content),
      similarity: raw.similarity,
      ...(raw.vectorScore !== undefined ? { vectorScore: raw.vectorScore } : {}),
      ...(raw.keywordScore !== undefined ? { keywordScore: raw.keywordScore } : {}),
      ...(raw.finalScore !== undefined ? { finalScore: raw.finalScore } : {}),
    });
  }

  return {
    citations: newCitations,
    augmentedResult: {
      ...result,
      data: { ...result.data, results: augmentedItems },
    },
    nextMarker,
  };
}
