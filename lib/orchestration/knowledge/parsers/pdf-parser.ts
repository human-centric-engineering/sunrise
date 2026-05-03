/**
 * PDF document parser.
 *
 * Uses `pdf-parse` to extract text from digital-native PDFs. Scanned
 * PDFs (image-only) produce empty text and are surfaced via per-page
 * warnings — the admin sees which page ranges need external OCR
 * (macOS Preview, Adobe Acrobat, `ocrmypdf`) before re-uploading.
 *
 * PDF parsing is inherently unreliable for complex layouts (multi-column,
 * footnotes, tables). This parser extracts best-effort text intended for
 * a **preview step** — the admin reviews and optionally corrects the
 * extracted text before it proceeds to chunking + embedding.
 */

import { PDFParse } from 'pdf-parse';
import type {
  PageInfo,
  ParsedDocument,
  ParsedSection,
} from '@/lib/orchestration/knowledge/parsers/types';

/** Minimum text length to consider the whole document as having extractable content. */
const MIN_VIABLE_TEXT_LENGTH = 50;
/** Per-page char count below which a page is treated as scanned-suspect. */
const PAGE_SCANNED_THRESHOLD = 50;

interface PageEntry {
  num: number;
  text: string;
}

interface RawPageResult {
  num?: number;
  text?: string;
}

/** Read per-page text from the PDF parse result, falling back to form-feed split. */
function extractPages(
  textResultPages: ReadonlyArray<RawPageResult> | undefined,
  rawText: string
): PageEntry[] {
  if (textResultPages && textResultPages.length > 0) {
    return textResultPages.map((p, idx) => ({
      num: typeof p.num === 'number' ? p.num : idx + 1,
      text: (p.text ?? '').trim(),
    }));
  }
  // Legacy fallback: split the joined text on form-feed.
  const split = rawText.split(/\f/);
  return split.map((text, idx) => ({ num: idx + 1, text: text.trim() }));
}

/**
 * Group consecutive scanned-suspect pages into ranges and produce one warning
 * per range, e.g. "Pages 4–7 of 22 produced no extractable text — likely scanned".
 */
function buildScannedWarnings(pageInfo: PageInfo[]): string[] {
  if (pageInfo.length === 0) return [];

  const warnings: string[] = [];
  const total = pageInfo.length;
  let rangeStart: number | null = null;

  const flush = (endNum: number): void => {
    if (rangeStart === null) return;
    const label = rangeStart === endNum ? `Page ${rangeStart}` : `Pages ${rangeStart}–${endNum}`;
    warnings.push(
      `${label} of ${total} produced no extractable text — likely scanned. ` +
        'Consider extracting these pages externally and pasting into the editor below.'
    );
    rangeStart = null;
  };

  let prevNum: number | null = null;
  for (const page of pageInfo) {
    if (!page.hasText) {
      if (rangeStart === null) rangeStart = page.num;
      prevNum = page.num;
    } else if (rangeStart !== null && prevNum !== null) {
      flush(prevNum);
      prevNum = page.num;
    } else {
      prevNum = page.num;
    }
  }
  if (rangeStart !== null && prevNum !== null) flush(prevNum);

  return warnings;
}

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

  const pageEntries = extractPages(
    textResult.pages as ReadonlyArray<RawPageResult> | undefined,
    rawText
  );
  const pageInfo: PageInfo[] = pageEntries.map((p) => ({
    num: p.num,
    charCount: p.text.length,
    hasText: p.text.length >= PAGE_SCANNED_THRESHOLD,
  }));

  const allEmpty = pageInfo.length === 0 || pageInfo.every((p) => !p.hasText);
  if (allEmpty && rawText.length < MIN_VIABLE_TEXT_LENGTH) {
    warnings.push(
      'PDF produced very little or no text. This may be a scanned document (image-only). ' +
        'Please provide a digital-native format (EPUB, DOCX, or TXT) instead.'
    );
  } else {
    warnings.push(...buildScannedWarnings(pageInfo));
  }

  const sections: ParsedSection[] = [];
  const nonEmptyPages = pageEntries.filter((p) => p.text.length > 0);
  if (nonEmptyPages.length > 1) {
    nonEmptyPages.forEach((page, idx) => {
      sections.push({
        title: `Page ${page.num}`,
        content: page.text,
        order: idx,
      });
    });
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
    pageInfo,
    warnings,
  };
}
