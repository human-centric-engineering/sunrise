/**
 * Markdown Document Chunker
 *
 * Splits markdown documents into embeddable chunks for the knowledge base.
 * Handles both pattern documents (with numbered patterns and subsections)
 * and generic markdown documents.
 */

import { logger } from '@/lib/logging';

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

/** Strip mermaid diagram code blocks (not useful for embeddings) */
function stripMermaidBlocks(content: string): string {
  return content.replace(/```mermaid[\s\S]*?```/g, '').trim();
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
      // Split large section by paragraphs
      const paragraphs = section.body.split(/\n\n+/);
      let currentBody = '';
      for (const para of paragraphs) {
        const testBody = currentBody ? `${currentBody}\n\n${para}` : para;
        const testContent = section.header ? `${section.header}\n\n${testBody}` : testBody;
        if (estimateTokens(testContent) > MAX_CHUNK_TOKENS && currentBody) {
          const content = section.header ? `${section.header}\n\n${currentBody}` : currentBody;
          result.push({ header: section.header, body: currentBody, combinedContent: content });
          currentBody = para;
        } else {
          currentBody = testBody;
        }
      }
      if (currentBody) {
        const content = section.header ? `${section.header}\n\n${currentBody}` : currentBody;
        result.push({ header: section.header, body: currentBody, combinedContent: content });
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
 * @returns Array of structured chunks ready for embedding
 */
export function chunkMarkdownDocument(content: string, documentName: string): Chunk[] {
  const documentSlug = slugify(documentName);
  const cleaned = stripMermaidBlocks(content);
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
