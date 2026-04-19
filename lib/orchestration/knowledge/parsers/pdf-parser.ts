/**
 * PDF document parser.
 *
 * Uses `pdf-parse` to extract text from digital-native PDFs. Scanned
 * PDFs (image-only) are explicitly NOT supported — they produce empty
 * text and the parser flags this as a warning.
 *
 * PDF parsing is inherently unreliable for complex layouts (multi-column,
 * footnotes, tables). This parser extracts best-effort text intended for
 * a **preview step** — the admin reviews and optionally corrects the
 * extracted text before it proceeds to chunking + embedding.
 */

import { PDFParse } from 'pdf-parse';
import type { ParsedDocument, ParsedSection } from './types';

/** Minimum text length to consider a PDF as having extractable content. */
const MIN_VIABLE_TEXT_LENGTH = 50;

export async function parsePdf(buffer: Buffer, fileName: string): Promise<ParsedDocument> {
  const warnings: string[] = [];

  const parser = new PDFParse({ data: buffer });
  const [textResult, infoResult] = await Promise.all([parser.getText(), parser.getInfo()]);

  const metadata: Record<string, string> = { format: 'pdf' };
  const pdfInfo = infoResult.info as Record<string, unknown> | undefined;
  const rawTitle = pdfInfo?.Title;
  const rawAuthor = pdfInfo?.Author;
  if (typeof rawTitle === 'string' && rawTitle) metadata.title = rawTitle;
  if (typeof rawAuthor === 'string' && rawAuthor) metadata.author = rawAuthor;
  if (infoResult.total) metadata.pages = String(infoResult.total);

  const rawText = textResult.text?.trim() ?? '';

  if (rawText.length < MIN_VIABLE_TEXT_LENGTH) {
    warnings.push(
      'PDF produced very little or no text. This may be a scanned document (image-only). ' +
        'Please provide a digital-native format (EPUB, DOCX, or TXT) instead.'
    );
  }

  // Split on page breaks (pdf-parse inserts form feed characters between pages)
  const pageTexts = rawText.split(/\f/).filter((p: string) => p.trim().length > 0);

  const sections: ParsedSection[] = [];
  if (pageTexts.length > 1) {
    // Group pages into sections — every page is a section for now.
    // The admin can review and correct before chunking.
    for (let i = 0; i < pageTexts.length; i++) {
      sections.push({
        title: `Page ${i + 1}`,
        content: pageTexts[i].trim(),
        order: i,
      });
    }
  } else if (rawText.length > 0) {
    sections.push({ title: '', content: rawText, order: 0 });
  }

  const title = metadata.title || fileName.replace(/\.[^.]+$/, '');

  return {
    title,
    author: metadata.author,
    sections,
    fullText: rawText,
    metadata,
    warnings,
  };
}
