/**
 * Document Parser Registry
 *
 * Routes file buffers to the appropriate format-specific parser based on
 * file extension. Each parser normalizes its output to a `ParsedDocument`
 * containing structured sections and full text.
 *
 * Supported formats:
 *   - .txt  — plain text, ~90% reliability
 *   - .md   — markdown (passed through as-is to existing chunker)
 *   - .csv  — RFC 4180 with delimiter sniffing, row-level chunking
 *   - .epub — EPUB ebooks, ~85% reliability (best for books)
 *   - .docx — Word documents via mammoth, ~80% reliability
 *   - .pdf  — PDF via pdf-parse, 40-70% reliability (requires preview step)
 */

import { extname } from 'path';
import { logger } from '@/lib/logging';
import type { ParsedDocument } from '@/lib/orchestration/knowledge/parsers/types';
import { parseTxt } from '@/lib/orchestration/knowledge/parsers/txt-parser';
import { parseCsv } from '@/lib/orchestration/knowledge/parsers/csv-parser';
import { parseDocx } from '@/lib/orchestration/knowledge/parsers/docx-parser';
import { parseEpub } from '@/lib/orchestration/knowledge/parsers/epub-parser';
import { parsePdf } from '@/lib/orchestration/knowledge/parsers/pdf-parser';

export type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

/** Optional per-call parsing controls. Format-specific keys are honored only by their parser. */
export interface ParseDocumentOptions {
  /** PDF only: when true, run pdf-parse `getTable()` per page and inject markdown pipe tables. */
  extractTables?: boolean;
}

/** Formats that require a preview/confirmation step before chunking. */
export const PREVIEW_REQUIRED_EXTENSIONS = new Set(['.pdf']);

/** Formats that are directly chunkable without preview. */
export const DIRECT_CHUNK_EXTENSIONS = new Set(['.md', '.txt', '.csv', '.epub', '.docx']);

/**
 * Parse a document buffer into structured text content.
 *
 * @param buffer - Raw file content
 * @param fileName - Original file name (used to detect format via extension)
 * @returns Parsed document with sections, full text, and metadata
 * @throws Error if the format is unsupported
 */
export async function parseDocument(
  buffer: Buffer,
  fileName: string,
  opts: ParseDocumentOptions = {}
): Promise<ParsedDocument> {
  const ext = extname(fileName).toLowerCase();

  logger.info('Parsing document', { fileName, format: ext, sizeBytes: buffer.length });

  let result: ParsedDocument;

  switch (ext) {
    case '.txt':
      result = parseTxt(buffer, fileName);
      break;
    case '.csv':
      result = parseCsv(buffer, fileName);
      break;
    case '.md': {
      // Markdown is passed through as a single section — the existing
      // chunkMarkdownDocument() handles the structural splitting.
      // Normalize CRLF → LF so the chunker's regex (/^(## .+)$/gm) matches correctly.
      const mdText = buffer.toString('utf-8').replace(/\r\n/g, '\n');
      result = {
        title: fileName.replace(/\.[^.]+$/, ''),
        sections: [{ title: '', content: mdText, order: 0 }],
        fullText: mdText,
        metadata: { format: 'markdown' },
        warnings: [],
      };
      break;
    }
    case '.epub':
      result = await parseEpub(buffer, fileName);
      break;
    case '.docx':
      result = await parseDocx(buffer, fileName);
      break;
    case '.pdf':
      result = await parsePdf(buffer, fileName, { extractTables: opts.extractTables });
      break;
    default:
      throw new Error(`Unsupported document format: ${ext}`);
  }

  logger.info('Document parsed', {
    fileName,
    format: ext,
    sections: result.sections.length,
    fullTextLength: result.fullText.length,
    warnings: result.warnings.length,
  });

  return result;
}

/**
 * Check whether a file extension requires the preview step.
 */
export function requiresPreview(fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  return PREVIEW_REQUIRED_EXTENSIONS.has(ext);
}
