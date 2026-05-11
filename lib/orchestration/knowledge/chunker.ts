/**
 * Knowledge-Base Chunkers
 *
 * Two chunking strategies live here, both producing the shared `Chunk` shape
 * consumed by the embedding + insert pipeline:
 *
 * - `chunkMarkdownDocument` — heading-aware splitting for markdown (and the
 *   plain-text / DOCX / EPUB / confirmed-PDF paths that all flow through it).
 *   Splits on `##` then `###`, then merges/splits sections to land in the
 *   50–800 token range.
 * - `chunkCsvDocument` — row-atomic splitting for CSV. One chunk per data
 *   row, batched into groups of 10 above 5,000 rows so embedding cost stays
 *   bounded. Each chunk's content is the pipe-joined `Header: Value | …`
 *   string emitted by `csv-parser.ts`.
 */

import { logger } from '@/lib/logging';
import type { ParsedDocument } from '@/lib/orchestration/knowledge/parsers/types';

/** Output chunk from the chunking process */
export interface Chunk {
  id: string;
  content: string;
  chunkType: string;
  patternNumber: number | null;
  patternName: string | null;
  category: string | null;
  section: string | null;
  keywords: string | null;
  estimatedTokens: number;
}

/** Target chunk size range in tokens */
const MIN_CHUNK_TOKENS = 50;
const MAX_CHUNK_TOKENS = 800;

/** Rough token estimate: ~4 characters per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Generate a URL-safe slug from text */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/** Strip all fenced code blocks (not useful for embeddings, and prevents
 *  false heading detection on `###` lines inside code examples). */
function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '').trim();
}

/**
 * Split a metadata body on commas, ignoring commas inside double-quoted values.
 * Used so `keywords="retry,backoff,circuit-breaker"` is treated as a single pair.
 */
function splitMetadataPairs(input: string): string[] {
  const pairs: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === ',' && !inQuotes) {
      if (current.trim()) pairs.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) pairs.push(current);
  return pairs.map((p) => p.trim());
}

/**
 * Parse HTML comment metadata blocks.
 *
 * Format:
 *   <!-- metadata: key=value, key2=value2 -->
 *
 * Values containing commas must be double-quoted:
 *   <!-- metadata: keywords="retry,backoff,circuit-breaker" -->
 *
 * Surrounding double quotes are stripped from parsed values. Equals signs
 * inside values are preserved (first `=` is the separator).
 */
export function parseMetadataComments(content: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const regex = /<!--\s*metadata:\s*(.*?)\s*-->/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const pairs = splitMetadataPairs(match[1]);
    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      const key = pair.slice(0, eqIdx).trim();
      let value = pair.slice(eqIdx + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (key) metadata[key] = value;
    }
  }
  return metadata;
}

/** Strip metadata comments from content */
function stripMetadataComments(content: string): string {
  return content.replace(/<!--\s*metadata:.*?-->/g, '').trim();
}

/**
 * Detect if a ## header is a pattern header (e.g., "## 12. Exception Handling & Recovery")
 * Returns { number, name } or null.
 */
function parsePatternHeader(header: string): { number: number; name: string } | null {
  const match = header.match(/^##\s+(\d{1,2})\.\s+(.+)$/);
  if (!match) return null;
  return { number: parseInt(match[1], 10), name: match[2].trim() };
}

/**
 * Split text on a heading level, returning sections with their header text.
 */
function splitOnHeadings(
  content: string,
  level: '##' | '###'
): Array<{ header: string; body: string }> {
  const regex = level === '##' ? /^(## .+)$/gm : /^(### .+)$/gm;
  const sections: Array<{ header: string; body: string }> = [];
  const matches = [...content.matchAll(regex)];

  if (matches.length === 0) {
    return [{ header: '', body: content.trim() }];
  }

  // Content before the first heading
  const preamble = content.slice(0, matches[0].index).trim();
  if (preamble) {
    sections.push({ header: '', body: preamble });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? content.length) : content.length;
    sections.push({
      header: matches[i][1].replace(/^#{2,3}\s+/, '').trim(),
      body: content.slice(start, end).trim(),
    });
  }

  return sections;
}

/**
 * Tiered separators tried in order when splitting oversized content. Each
 * tier is a [regex, joiner] pair — split by the regex, then join the
 * pieces back into chunks using the joiner. We escalate from coarsest to
 * finest so chunks stay human-meaningful for as long as possible: try to
 * preserve paragraph structure first, then drop to lines, then sentences,
 * and finally a character window when the input has no structure at all
 * (e.g. one page of a PDF that pdfjs-dist extracted as a single
 * concatenated string).
 *
 * The empty regex tier triggers character-window slicing — used as a last
 * resort so we never return an oversized chunk regardless of input shape.
 */
const SPLIT_TIERS: ReadonlyArray<{ regex: RegExp | null; joiner: string }> = [
  { regex: /\n\n+/, joiner: '\n\n' }, // paragraphs
  { regex: /\n/, joiner: '\n' }, // lines
  { regex: /(?<=\. )/, joiner: '' }, // sentences (lookbehind keeps the period)
  { regex: null, joiner: '' }, // char-window fallback
];

/**
 * Slice a string into ~`maxChars`-sized pieces. Used as the final
 * fallback when the input has no structural separators at all — a
 * dense block of text with no spaces, line breaks, or sentence
 * endings. Pieces land slightly under maxChars to leave a token-count
 * safety margin against the ~4-chars/token approximation.
 */
function sliceByChars(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Recursively split a body so every piece fits in `maxTokens` when
 * combined with `header` (`<header>\n\n<piece>`). Tries the
 * separator tiers in order — paragraphs, lines, sentences, finally
 * char-window — and stops as soon as a tier produces pieces that
 * each fit. Returns the original `text` unchanged when it already
 * fits, so headers / small sections short-circuit without splitting.
 *
 * Without this fallback chain, PDF text (which pdfjs-dist extracts
 * with `\n` line separators but rarely `\n\n` paragraph breaks)
 * would collapse into one oversized chunk per document.
 */
function splitBodyToFit(text: string, maxTokens: number, header: string): string[] {
  const headerOverhead = header ? estimateTokens(`${header}\n\n`) : 0;
  const effectiveMax = Math.max(maxTokens - headerOverhead, 1);

  const tryTier = (input: string, tierIndex: number): string[] => {
    if (estimateTokens(input) <= effectiveMax) return [input];
    if (tierIndex >= SPLIT_TIERS.length) return [input]; // unreachable

    const tier = SPLIT_TIERS[tierIndex];
    const parts =
      tier.regex === null
        ? sliceByChars(input, effectiveMax * 4)
        : input
            .split(tier.regex)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);

    // If splitting didn't subdivide the input, drop to the next finer
    // tier rather than spinning forever on the same separator.
    if (parts.length <= 1) return tryTier(input, tierIndex + 1);

    const out: string[] = [];
    let buffer = '';
    for (const part of parts) {
      const test = buffer ? `${buffer}${tier.joiner}${part}` : part;
      if (estimateTokens(test) > effectiveMax && buffer) {
        // Flush buffer — but recurse first to catch the case where
        // `buffer` is itself a single oversized part (e.g. one
        // monstrous line that the line-tier returned as-is).
        out.push(...tryTier(buffer, tierIndex + 1));
        buffer = part;
      } else {
        buffer = test;
      }
    }
    if (buffer) out.push(...tryTier(buffer, tierIndex + 1));
    return out;
  };

  return tryTier(text, 0);
}

/**
 * Merge small consecutive sections to meet minimum chunk size.
 * Splits oversized sections to stay under maximum.
 */
function normalizeChunkSizes(
  sections: Array<{ header: string; body: string; combinedContent: string }>
): Array<{ header: string; body: string; combinedContent: string }> {
  const result: Array<{ header: string; body: string; combinedContent: string }> = [];

  let buffer: { header: string; body: string; combinedContent: string } | null = null;

  for (const section of sections) {
    const tokens = estimateTokens(section.combinedContent);

    if (tokens > MAX_CHUNK_TOKENS) {
      // Flush buffer first
      if (buffer) {
        result.push(buffer);
        buffer = null;
      }
      // Split oversized body using the tiered separator chain. Falls
      // back from paragraphs → lines → sentences → char-window so
      // sources without blank-line paragraph breaks (PDFs extracted
      // by pdfjs-dist are the canonical case) still get split.
      const pieces = splitBodyToFit(section.body, MAX_CHUNK_TOKENS, section.header);
      for (const piece of pieces) {
        const content = section.header ? `${section.header}\n\n${piece}` : piece;
        result.push({ header: section.header, body: piece, combinedContent: content });
      }
    } else if (tokens < MIN_CHUNK_TOKENS && buffer) {
      // Merge with buffer — append body only (not combinedContent which includes the header)
      buffer.body += `\n\n${section.body}`;
      buffer.combinedContent = buffer.header ? `${buffer.header}\n\n${buffer.body}` : buffer.body;
    } else if (tokens < MIN_CHUNK_TOKENS && !buffer) {
      buffer = { ...section };
    } else {
      if (buffer) {
        result.push(buffer);
        buffer = null;
      }
      result.push(section);
    }
  }

  if (buffer) result.push(buffer);
  return result;
}

/**
 * Chunk a pattern section (## N. Pattern Name) into subsection chunks.
 */
function chunkPatternSection(
  body: string,
  patternNumber: number,
  patternName: string,
  documentSlug: string,
  commentMetadata: Record<string, string>
): Chunk[] {
  const subsections = splitOnHeadings(body, '###');
  const chunks: Chunk[] = [];

  const prepared = subsections.map((sub) => {
    const prefix = `${patternName}`;
    const combinedContent = sub.header
      ? `${prefix} — ${sub.header}\n\n${sub.body}`
      : `${prefix}\n\n${sub.body}`;
    return { ...sub, combinedContent };
  });

  const normalized = normalizeChunkSizes(prepared);

  for (const section of normalized) {
    const sectionSlug = section.header ? slugify(section.header) : 'overview';
    chunks.push({
      id: `${documentSlug}-pattern-${patternNumber}-${sectionSlug}`,
      content: stripMetadataComments(section.combinedContent),
      chunkType: section.header ? 'pattern_section' : 'pattern_overview',
      patternNumber,
      patternName,
      category: commentMetadata['category'] ?? null,
      section: section.header || 'overview',
      keywords: commentMetadata['keywords'] ?? null,
      estimatedTokens: estimateTokens(section.combinedContent),
    });
  }

  return chunks;
}

/**
 * Chunk a generic (non-pattern) section into appropriately sized chunks.
 */
function chunkGenericSection(
  header: string,
  body: string,
  documentSlug: string,
  commentMetadata: Record<string, string>
): Chunk[] {
  const subsections = splitOnHeadings(body, '###');
  const chunks: Chunk[] = [];

  const prepared = subsections.map((sub) => {
    const combinedContent = sub.header
      ? `${header ? `${header} — ` : ''}${sub.header}\n\n${sub.body}`
      : header
        ? `${header}\n\n${sub.body}`
        : sub.body;
    return { ...sub, combinedContent };
  });

  const normalized = normalizeChunkSizes(prepared);

  for (let i = 0; i < normalized.length; i++) {
    const section = normalized[i];
    const sectionSlug = section.header
      ? slugify(section.header)
      : header
        ? slugify(header)
        : `section-${i}`;
    const suffix = normalized.length > 1 ? `-${i}` : '';

    // Infer chunk type from header content
    let chunkType = 'pattern_section';
    const headerLower = (header || section.header || '').toLowerCase();
    if (headerLower.includes('glossary')) chunkType = 'glossary';
    else if (headerLower.includes('recipe') || headerLower.includes('composition'))
      chunkType = 'composition_recipe';
    else if (headerLower.includes('selection') || headerLower.includes('guide'))
      chunkType = 'selection_guide';
    else if (headerLower.includes('cost') || headerLower.includes('pricing'))
      chunkType = 'cost_reference';
    else if (headerLower.includes('context engineering')) chunkType = 'context_engineering';
    else if (headerLower.includes('emerging') || headerLower.includes('frontier'))
      chunkType = 'emerging_concepts';
    else if (headerLower.includes('ecosystem') || headerLower.includes('tool'))
      chunkType = 'ecosystem';
    else if (headerLower.includes('getting started') || headerLower.includes('overview'))
      chunkType = 'pattern_overview';

    chunks.push({
      id: `${documentSlug}-${sectionSlug}${suffix}`,
      content: stripMetadataComments(section.combinedContent),
      chunkType,
      patternNumber: null,
      patternName: null,
      category: commentMetadata['category'] ?? null,
      section: section.header || header || null,
      keywords: commentMetadata['keywords'] ?? null,
      estimatedTokens: estimateTokens(section.combinedContent),
    });
  }

  return chunks;
}

/**
 * Split a markdown document into embeddable chunks.
 *
 * Handles pattern documents (with ## N. Pattern Name sections) and
 * generic markdown documents. Strips mermaid diagrams and parses
 * HTML comment metadata.
 *
 * @param content - Raw markdown content
 * @param documentName - Name of the document (used for chunk IDs)
 * @param documentId - Unique document ID (first 8 chars used in chunk keys to prevent collisions)
 * @returns Array of structured chunks ready for embedding
 */
export function chunkMarkdownDocument(
  content: string,
  documentName: string,
  documentId?: string
): Chunk[] {
  const idPrefix = documentId ? documentId.slice(0, 8) : '';
  const documentSlug = idPrefix ? `${slugify(documentName)}-${idPrefix}` : slugify(documentName);
  const cleaned = stripCodeBlocks(content);
  const globalMetadata = parseMetadataComments(cleaned);

  const topSections = splitOnHeadings(cleaned, '##');
  const chunks: Chunk[] = [];

  for (const section of topSections) {
    const sectionMetadata = {
      ...globalMetadata,
      ...parseMetadataComments(section.body),
    };

    const patternInfo = section.header ? parsePatternHeader(`## ${section.header}`) : null;

    if (patternInfo) {
      chunks.push(
        ...chunkPatternSection(
          section.body,
          patternInfo.number,
          patternInfo.name,
          documentSlug,
          sectionMetadata
        )
      );
    } else if (section.body.trim()) {
      chunks.push(
        ...chunkGenericSection(section.header, section.body, documentSlug, sectionMetadata)
      );
    }
  }

  logger.info('Document chunked', {
    document: documentName,
    chunkCount: chunks.length,
    totalTokens: chunks.reduce((sum, c) => sum + c.estimatedTokens, 0),
  });

  return chunks;
}

/** CSVs above this row count switch from one-row-per-chunk to batched chunks. */
export const CSV_ROW_BATCH_THRESHOLD = 5000;
/** Rows per chunk when batching kicks in. */
export const CSV_ROWS_PER_BATCH = 10;
/**
 * Per-row character cap. Rows above this length are dropped before embedding
 * because every embedding provider rejects inputs over its token budget
 * (Voyage voyage-3 ≈ 32k tokens; OpenAI text-embedding-3-small 8,191 tokens).
 * 32,000 chars is a generous safety margin (~8,000 tokens at the standard
 * 4-chars/token approximation) that suits every provider Sunrise ships with.
 *
 * Realistic CSV rows are well under this — a row that crosses it almost
 * always means the source has a binary blob or a JSON payload stuffed into
 * one cell, which a row-atomic CSV chunker can't usefully embed anyway.
 */
export const CSV_MAX_ROW_CHARS = 32_000;

/**
 * Chunk a parsed CSV document into one chunk per row (or batched rows for
 * very large CSVs).
 *
 * Each chunk's content is the pipe-joined "Header: Value | Header: Value"
 * string already produced by `parseCsv`. Row-atomic chunking lets retrieval
 * surface a single matching row rather than a diluted multi-row window.
 *
 * Above {@link CSV_ROW_BATCH_THRESHOLD} rows, batches of {@link CSV_ROWS_PER_BATCH}
 * are joined into a single chunk to cap embedding cost.
 */
export function chunkCsvDocument(
  parsed: ParsedDocument,
  documentName: string,
  documentId?: string
): Chunk[] {
  const idPrefix = documentId ? documentId.slice(0, 8) : '';
  const documentSlug = idPrefix ? `${slugify(documentName)}-${idPrefix}` : slugify(documentName);

  const chunks: Chunk[] = [];
  const totalRows = parsed.sections.length;
  const shouldBatch = totalRows > CSV_ROW_BATCH_THRESHOLD;

  if (shouldBatch) {
    logger.warn('CSV exceeds row threshold — batching rows per chunk', {
      document: documentName,
      rowCount: totalRows,
      threshold: CSV_ROW_BATCH_THRESHOLD,
      rowsPerBatch: CSV_ROWS_PER_BATCH,
    });
  }

  if (!shouldBatch) {
    // Use the array index for the chunk ID rather than `section.order` —
    // `order` is an optional hint from the parser; if two sections happened to
    // share a value the chunk_key UNIQUE constraint would reject the insert.
    for (let i = 0; i < parsed.sections.length; i++) {
      const section = parsed.sections[i];
      chunks.push({
        id: `${documentSlug}-row-${i + 1}`,
        content: section.content,
        chunkType: 'csv_row',
        patternNumber: null,
        patternName: null,
        category: null,
        section: section.title,
        keywords: null,
        estimatedTokens: estimateTokens(section.content),
      });
    }
  } else {
    for (let i = 0; i < parsed.sections.length; i += CSV_ROWS_PER_BATCH) {
      const batch = parsed.sections.slice(i, i + CSV_ROWS_PER_BATCH);
      const start = i + 1;
      const end = i + batch.length;
      const content = batch.map((s) => s.content).join('\n');
      chunks.push({
        id: `${documentSlug}-rows-${start}-${end}`,
        content,
        chunkType: 'csv_row',
        patternNumber: null,
        patternName: null,
        category: null,
        section: `Rows ${start}–${end}`,
        keywords: null,
        estimatedTokens: estimateTokens(content),
      });
    }
  }

  logger.info('CSV chunked', {
    document: documentName,
    rowCount: totalRows,
    chunkCount: chunks.length,
    batched: shouldBatch,
  });

  return chunks;
}
