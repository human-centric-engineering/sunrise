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
import { chunkBySemanticBreakpoints } from '@/lib/orchestration/knowledge/semantic-chunker';
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

// Numeric chunker config is defined in `chunker-config.ts` so client
// components can render the values without pulling the embedder/DB
// client into the browser bundle. Re-exported here so existing
// `chunker.ts` imports keep working unchanged.
export {
  MIN_CHUNK_TOKENS,
  MAX_CHUNK_TOKENS,
  CHARS_PER_TOKEN_ESTIMATE,
} from '@/lib/orchestration/knowledge/chunker-config';
import {
  CHARS_PER_TOKEN_ESTIMATE,
  MAX_CHUNK_TOKENS,
  MIN_CHUNK_TOKENS,
} from '@/lib/orchestration/knowledge/chunker-config';

/** Rough token estimate: ~4 characters per token for English text */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
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
 * Pull a short title out of a chunk body — used when the chunk has no
 * explicit heading (semantic chunking on a PDF, generic prose, etc.).
 *
 * Heuristic: take the first sentence (or first ~80 chars if no
 * sentence boundary), strip surrounding whitespace, normalise inner
 * whitespace, and cap at 80 chars with an ellipsis. This won't
 * produce a perfectly summarised title but it gives the graph view
 * something readable — "A Human-Centric Venture Studio Entity"
 * beats "(no title)".
 */
function deriveSectionTitle(body: string): string | null {
  const text = body.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const sentenceMatch = text.match(/^.{10,120}?[.!?](?=\s|$)/);
  const candidate = sentenceMatch ? sentenceMatch[0] : text;
  const trimmed = candidate.length > 80 ? `${candidate.slice(0, 77)}...` : candidate;
  return trimmed.trim() || null;
}

/**
 * Map a header / section heading to a chunkType label. The match list
 * preserves the original pattern-docs vocabulary so the seeded
 * Agentic Design Patterns knowledge base keeps its specific labels;
 * the default for everything else is `'text'`, which is what the
 * graph view should show for arbitrary PDF / DOCX content rather
 * than the misleading legacy `'pattern_section'`.
 */
function inferChunkType(headerSource: string): string {
  const headerLower = headerSource.toLowerCase();
  if (headerLower.includes('glossary')) return 'glossary';
  if (headerLower.includes('recipe') || headerLower.includes('composition'))
    return 'composition_recipe';
  if (headerLower.includes('selection') || headerLower.includes('guide')) return 'selection_guide';
  if (headerLower.includes('cost') || headerLower.includes('pricing')) return 'cost_reference';
  if (headerLower.includes('context engineering')) return 'context_engineering';
  if (headerLower.includes('emerging') || headerLower.includes('frontier'))
    return 'emerging_concepts';
  if (headerLower.includes('ecosystem') || headerLower.includes('tool')) return 'ecosystem';
  if (headerLower.includes('getting started') || headerLower.includes('overview'))
    return 'pattern_overview';
  return 'text';
}

/**
 * Chunk a generic (non-pattern) section into appropriately sized chunks.
 *
 * Routing strategy:
 *
 *   1. If the section has explicit `###` subheadings, use them as
 *      structural boundaries (authors who marked up their content get
 *      to keep that intent). Falls through to size-normalisation
 *      across the resulting subsections.
 *
 *   2. If there are no subheadings AND the body is oversized,
 *      semantic chunking takes over: every sentence is embedded, and
 *      chunk boundaries land at the largest topic-distance jumps
 *      (75th percentile by default). This avoids the structural
 *      splitter's mid-sentence cuts on PDF / DOCX / transcript text.
 *
 *   3. On semantic-chunker failure (provider unreachable, fewer than
 *      4 sentences, etc.) the structural fallback kicks back in via
 *      `normalizeChunkSizes` → `splitBodyToFit`. The user still gets
 *      chunks; semantic chunking is a quality upgrade, not a hard
 *      requirement.
 */
async function chunkGenericSection(
  header: string,
  body: string,
  documentSlug: string,
  commentMetadata: Record<string, string>
): Promise<Chunk[]> {
  const subsections = splitOnHeadings(body, '###');
  const hasExplicitSubheadings = subsections.some((s) => s.header.length > 0);

  // Semantic path: no author-supplied structure inside this section
  // and the body is oversized. We embed sentences and split at topic
  // boundaries; if that throws (no embedding provider, network error,
  // too few sentences) we silently fall through to the structural
  // path below.
  if (!hasExplicitSubheadings && estimateTokens(body) > MAX_CHUNK_TOKENS) {
    try {
      const semanticBodies = await chunkBySemanticBreakpoints(body, {
        minTokens: MIN_CHUNK_TOKENS,
        maxTokens: MAX_CHUNK_TOKENS,
      });
      if (semanticBodies.length > 1) {
        const chunkType = inferChunkType(header);
        return semanticBodies.map((piece, i) => {
          const combinedContent = header ? `${header}\n\n${piece}` : piece;
          const derivedTitle = deriveSectionTitle(piece);
          const sectionLabel = header || derivedTitle || `section-${i}`;
          const sectionSlug = slugify(sectionLabel);
          const suffix = semanticBodies.length > 1 ? `-${i}` : '';
          return {
            id: `${documentSlug}-${sectionSlug}${suffix}`,
            content: stripMetadataComments(combinedContent),
            chunkType,
            patternNumber: null,
            patternName: null,
            category: commentMetadata['category'] ?? null,
            section: header || derivedTitle,
            keywords: commentMetadata['keywords'] ?? null,
            estimatedTokens: estimateTokens(combinedContent),
          };
        });
      }
    } catch (err) {
      logger.warn('Semantic chunking failed — falling back to structural splitter', {
        error: err instanceof Error ? err.message : String(err),
        documentSlug,
        bodyTokens: estimateTokens(body),
      });
    }
  }

  // Structural path: either there are author-supplied `###`
  // subheadings (respect them) or semantic chunking didn't apply.
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
    // Derive a section title when there's no author-supplied header.
    // For a single-chunk no-header section we fall back to the header
    // arg; for sub-divided no-header sections (PDF prose split by
    // the structural fallback) we pull one from the chunk body.
    const derivedTitle = !section.header && !header ? deriveSectionTitle(section.body) : null;
    const sectionLabel = section.header || header || derivedTitle || `section-${i}`;
    const sectionSlug = slugify(sectionLabel);
    const suffix = normalized.length > 1 ? `-${i}` : '';

    const chunkType = inferChunkType(header || section.header || '');

    chunks.push({
      id: `${documentSlug}-${sectionSlug}${suffix}`,
      content: stripMetadataComments(section.combinedContent),
      chunkType,
      patternNumber: null,
      patternName: null,
      category: commentMetadata['category'] ?? null,
      section: section.header || header || derivedTitle,
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
 * Async because generic sections without explicit `###` subheadings
 * are routed through the semantic chunker, which embeds sentences to
 * find topic-boundary splits. Pattern sections stay on the structural
 * path — the `## N. Name` / `### Subheading` layout already encodes
 * semantic boundaries the author chose.
 *
 * @param content - Raw markdown content
 * @param documentName - Name of the document (used for chunk IDs)
 * @param documentId - Unique document ID (first 8 chars used in chunk keys to prevent collisions)
 * @returns Array of structured chunks ready for embedding
 */
export async function chunkMarkdownDocument(
  content: string,
  documentName: string,
  documentId?: string
): Promise<Chunk[]> {
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
      const generic = await chunkGenericSection(
        section.header,
        section.body,
        documentSlug,
        sectionMetadata
      );
      chunks.push(...generic);
    }
  }

  logger.info('Document chunked', {
    document: documentName,
    chunkCount: chunks.length,
    totalTokens: chunks.reduce((sum, c) => sum + c.estimatedTokens, 0),
  });

  return chunks;
}

// CSV chunking caps live in `chunker-config.ts` (server-free constants
// so they can also be rendered by client components). Re-exported here so
// existing imports from `chunker` keep working.
//
// Notes on the cap values:
//   - `CSV_MAX_ROW_CHARS` is a generous safety margin (~8,000 tokens at
//     4 chars/token) that suits every embedding provider Sunrise ships
//     with: Voyage voyage-3 ≈ 32k tokens, OpenAI text-embedding-3-small
//     8,191 tokens.
//   - Realistic CSV rows are well under this — a row that crosses it
//     almost always means the source has a binary blob or a JSON payload
//     stuffed into one cell, which a row-atomic CSV chunker can't
//     usefully embed anyway.
export {
  CSV_ROW_BATCH_THRESHOLD,
  CSV_ROWS_PER_BATCH,
  CSV_MAX_ROW_CHARS,
} from '@/lib/orchestration/knowledge/chunker-config';
import {
  CSV_ROW_BATCH_THRESHOLD,
  CSV_ROWS_PER_BATCH,
} from '@/lib/orchestration/knowledge/chunker-config';

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
