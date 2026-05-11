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

/** Options accepted by parsePdf. */
export interface ParsePdfOptions {
  /**
   * When true, run pdf-parse `getTable()` per page and append detected
   * vector-grid tables as markdown pipe tables fenced by HTML comments.
   * Default false — `getTable()` can produce false positives on pages with
   * non-tabular vector content.
   */
  extractTables?: boolean;
}

interface PageEntry {
  num: number;
  text: string;
}

interface RawPageResult {
  num?: number;
  text?: string;
}

interface RawPageTableResult {
  num: number;
  tables: ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>;
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
 * Render a table-array (rows of cells) as a markdown pipe table.
 * The first row is treated as the header row (mirrors common PDF table layout).
 * Returns the empty string for empty/degenerate tables.
 *
 * SECURITY INVARIANT — cell sanitisation only escapes pipes and replaces
 * newlines. It deliberately does NOT escape `<` / `>` / `&`, because:
 *
 *  1. Chunk content is rendered downstream by `react-markdown` with no
 *     plugins (see `components/admin/orchestration/knowledge/explore-tab.tsx`
 *     and `components/admin/orchestration/knowledge/document-chunks-modal.tsx`)
 *     — by default raw HTML in markdown source is treated as inert text,
 *     so a PDF cell containing `<script>` cannot execute.
 *  2. Storing HTML-escaped text would surface as visible `&lt;` entities in
 *     the PDF preview textarea, confusing admins who actually expect to see
 *     the literal extracted text before confirming.
 *
 * If a future change adds `rehype-raw` (or any plugin that interprets raw
 * HTML) to the chunk renderer, harden this function to also escape `<`,
 * `>`, and `&` before re-enabling that plugin. See the matching warning
 * in `explore-tab.tsx`.
 */
function renderMarkdownTable(table: ReadonlyArray<ReadonlyArray<string>>): string {
  if (table.length === 0) return '';
  const sanitize = (cell: string): string => (cell ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const widths = table[0].map((_, col) => Math.max(...table.map((row) => (row[col] ?? '').length)));
  if (widths.length === 0) return '';

  const header = table[0].map(sanitize);
  const separator = widths.map(() => '---');
  const body = table.slice(1).map((row) => row.map(sanitize));

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${separator.join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ];
  return lines.join('\n');
}

/**
 * Append fenced markdown tables to each page's text. Tables for a page are
 * found by matching `pageTableResults[].num` to the page entry's num.
 */
function applyPageTables(
  pageEntries: PageEntry[],
  pageTableResults: ReadonlyArray<RawPageTableResult>
): { entries: PageEntry[]; tablesRendered: number } {
  let tablesRendered = 0;
  const byNum = new Map<number, ReadonlyArray<ReadonlyArray<ReadonlyArray<string>>>>();
  for (const r of pageTableResults) {
    if (typeof r.num === 'number' && Array.isArray(r.tables)) {
      byNum.set(r.num, r.tables);
    }
  }

  const entries = pageEntries.map((entry) => {
    const tables = byNum.get(entry.num);
    if (!tables || tables.length === 0) return entry;

    const blocks: string[] = [];
    for (const table of tables) {
      const md = renderMarkdownTable(table);
      if (md) {
        blocks.push(`<!-- table-start -->\n${md}\n<!-- table-end -->`);
        tablesRendered++;
      }
    }
    if (blocks.length === 0) return entry;

    const merged = entry.text ? `${entry.text}\n\n${blocks.join('\n\n')}` : blocks.join('\n\n');
    return { ...entry, text: merged };
  });

  return { entries, tablesRendered };
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

export async function parsePdf(
  buffer: Buffer,
  fileName: string,
  opts: ParsePdfOptions = {}
): Promise<ParsedDocument> {
  const warnings: string[] = [];

  const parser = new PDFParse({ data: buffer });
  // Must NOT run getText and getInfo via Promise.all: both call
  // PDFParse#load() which races on `if (this.doc === undefined)`.
  // Concurrent callers both reach pdfjs.getDocument(this.options),
  // and pdfjs transfers `data.buffer` via structuredClone's transfer
  // list — the second transfer hits a detached ArrayBuffer and Node
  // throws `DataCloneError: Cannot transfer object of unsupported type.`
  // Sequential awaits let the first call cache `this.doc` so the
  // second short-circuits without re-transferring the buffer.
  const infoResult = await parser.getInfo();
  const textResult = await parser.getText();

  const metadata: Record<string, string> = { format: 'pdf' };
  const pdfInfo = infoResult.info as Record<string, unknown> | undefined;
  const rawTitle = pdfInfo?.Title;
  const rawAuthor = pdfInfo?.Author;
  if (typeof rawTitle === 'string' && rawTitle) metadata.title = rawTitle;
  if (typeof rawAuthor === 'string' && rawAuthor) metadata.author = rawAuthor;
  if (infoResult.total) metadata.pages = String(infoResult.total);

  const rawText = textResult.text?.trim() ?? '';

  let pageEntries = extractPages(
    textResult.pages as ReadonlyArray<RawPageResult> | undefined,
    rawText
  );

  if (opts.extractTables) {
    const tableResult = await parser.getTable();
    const pageTableResults = (tableResult.pages ?? []) as ReadonlyArray<RawPageTableResult>;
    const applied = applyPageTables(pageEntries, pageTableResults);
    pageEntries = applied.entries;
    if (applied.tablesRendered > 0) {
      metadata.tablesExtracted = String(applied.tablesRendered);
    }
  }

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
  } else if (nonEmptyPages.length === 1) {
    sections.push({ title: '', content: nonEmptyPages[0].text, order: 0 });
  } else if (rawText.length > 0) {
    sections.push({ title: '', content: rawText, order: 0 });
  }

  // Rebuild fullText from the (possibly table-augmented) page entries so the
  // preview surface shows what the chunker sees. Falls back to rawText when no
  // pages were extracted.
  //
  // Pages are joined with `\n\n` (blank-line) rather than `\f` (form-feed).
  // pdfjs-dist's text extraction emits visual lines separated by `\n` but
  // almost never produces blank-line paragraph breaks, so the markdown
  // chunker's `body.split(/\n\n+/)` would see the entire document as one
  // "paragraph" and emit a single oversized chunk per document. Using `\n\n`
  // here makes each page boundary a paragraph boundary, which gives the
  // chunker something to split on. The chunker itself also falls back
  // through `\n` → sentence → char-window for pages that still exceed
  // MAX_CHUNK_TOKENS, so this isn't load-bearing — it's an alignment with
  // the chunker's separator vocabulary.
  const fullText =
    pageEntries.length > 0
      ? pageEntries
          .map((p) => p.text)
          .join('\n\n')
          .trim()
      : rawText;

  const title = metadata.title || fileName.replace(/\.[^.]+$/, '');

  return {
    title,
    author: metadata.author,
    sections,
    fullText,
    metadata,
    pageInfo,
    warnings,
  };
}
