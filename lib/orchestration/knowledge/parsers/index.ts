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
 *   - .epub — EPUB ebooks, ~85% reliability (best for books)
 *   - .docx — Word documents via mammoth, ~80% reliability
 *   - .pdf  — PDF via pdf-parse, 40-70% reliability (requires preview step)
 */

import { extname } from 'path';
import { logger } from '@/lib/logging';
import type { ParsedDocument } from './types';
import { parseTxt } from './txt-parser';
import { parseDocx } from './docx-parser';
import { parseEpub } from './epub-parser';
import { parsePdf } from './pdf-parser';

export type { ParsedDocument, ParsedSection } from './types';

/** Formats that require a preview/confirmation step before chunking. */
export const PREVIEW_REQUIRED_EXTENSIONS = new Set(['.pdf']);

/** Formats that are directly chunkable without preview. */
export const DIRECT_CHUNK_EXTENSIONS = new Set(['.md', '.txt', '.epub', '.docx']);

/**
 * Parse a document buffer into structured text content.
 *
 * @param buffer - Raw file content
 * @param fileName - Original file name (used to detect format via extension)
 * @returns Parsed document with sections, full text, and metadata
 * @throws Error if the format is unsupported
 */
export async function parseDocument(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const ext = extname(fileName).toLowerCase();

  logger.info('Parsing document', { fileName, format: ext, sizeBytes: buffer.length });

  let result: ParsedDocument;

  switch (ext) {
    case '.txt':
      result = parseTxt(buffer, fileName);
      break;
    case '.md':
      // Markdown is passed through as a single section — the existing
      // chunkMarkdownDocument() handles the structural splitting.
      result = {
        title: fileName.replace(/\.[^.]+$/, ''),
        sections: [{ title: '', content: buffer.toString('utf-8'), order: 0 }],
        fullText: buffer.toString('utf-8'),
        metadata: { format: 'markdown' },
        warnings: [],
      };
      break;
    case '.epub':
      result = await parseEpub(buffer, fileName);
      break;
    case '.docx':
      result = await parseDocx(buffer, fileName);
      break;
    case '.pdf':
      result = await parsePdf(buffer, fileName);
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
