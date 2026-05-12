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
/** Tunables for header/footer detection. See `stripHeadersAndFooters`. */
const HEADER_FOOTER_MARGIN_LINES = 2;
const HEADER_FOOTER_MIN_FREQUENCY = 0.3;
const HEADER_FOOTER_MIN_PAGES = 3;
const HEADER_FOOTER_MAX_LINE_LENGTH = 100;
const HEADER_FOOTER_STRIP_CAP_PER_SIDE = 3;

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
 * Normalise a candidate line for repetition matching: collapse whitespace,
 * replace digit runs with `#` (so "Page 3" and "Page 17" collapse together),
 * and lowercase. Returns the empty string when nothing meaningful remains.
 */
function normaliseMargin(line: string): string {
  return line.trim().replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase();
}

/**
 * Detect and strip repeated headers/footers from each page.
 *
 * PDF text extraction surfaces running headers, footers, and page numbers
 * as the first and last lines of each page — these add no semantic value
 * and pollute the chunker (a repeated "Chapter 4 — The Foo" line appears
 * once per page and dominates similarity search for that page's chunk).
 *
 * Algorithm:
 *   1. Collect the top N and bottom N non-blank lines of every page.
 *   2. Tally each normalised candidate (whitespace-collapsed, digits → `#`,
 *      lowercased) by page count.
 *   3. A candidate is treated as a header/footer if it appears on at
 *      least `HEADER_FOOTER_MIN_FREQUENCY` of pages AND at least
 *      `HEADER_FOOTER_MIN_PAGES` absolute pages. The two-floor rule keeps
 *      noisy short books (5–10 pages) from over-stripping.
 *   4. Strip matching lines from the top and bottom of each page, capped
 *      at `HEADER_FOOTER_STRIP_CAP_PER_SIDE` removals per side so we never
 *      eat the body if our heuristic misfires.
 *
 * Returns the rewritten page entries plus a count of stripped lines for
 * surfacing as metadata. No-ops on documents below `HEADER_FOOTER_MIN_PAGES`.
 */
function stripHeadersAndFooters(pages: PageEntry[]): {
  entries: PageEntry[];
  strippedCount: number;
  repeatedPatternCount: number;
} {
  if (pages.length < HEADER_FOOTER_MIN_PAGES) {
    return { entries: pages, strippedCount: 0, repeatedPatternCount: 0 };
  }

  const pageCountByKey = new Map<string, Set<number>>();
  for (const page of pages) {
    const lines = page.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    const candidates = new Set<string>();
    for (let i = 0; i < Math.min(HEADER_FOOTER_MARGIN_LINES, lines.length); i++) {
      candidates.add(lines[i]);
    }
    for (let i = Math.max(0, lines.length - HEADER_FOOTER_MARGIN_LINES); i < lines.length; i++) {
      candidates.add(lines[i]);
    }
    for (const c of candidates) {
      if (c.length > HEADER_FOOTER_MAX_LINE_LENGTH) continue;
      const key = normaliseMargin(c);
      if (!key) continue;
      let set = pageCountByKey.get(key);
      if (!set) {
        set = new Set<number>();
        pageCountByKey.set(key, set);
      }
      set.add(page.num);
    }
  }

  const minPages = Math.max(
    HEADER_FOOTER_MIN_PAGES,
    Math.ceil(pages.length * HEADER_FOOTER_MIN_FREQUENCY)
  );
  const repeats = new Set<string>();
  for (const [key, set] of pageCountByKey) {
    if (set.size >= minPages) repeats.add(key);
  }

  if (repeats.size === 0) {
    return { entries: pages, strippedCount: 0, repeatedPatternCount: 0 };
  }

  let strippedCount = 0;
  const entries = pages.map((page) => {
    const lines = page.text.split('\n');

    let topRemoved = 0;
    while (lines.length > 0 && topRemoved < HEADER_FOOTER_STRIP_CAP_PER_SIDE) {
      const candidate = lines[0].trim();
      if (candidate.length === 0) {
        lines.shift();
        continue;
      }
      if (
        candidate.length <= HEADER_FOOTER_MAX_LINE_LENGTH &&
        repeats.has(normaliseMargin(candidate))
      ) {
        lines.shift();
        topRemoved++;
        strippedCount++;
        continue;
      }
      break;
    }

    let bottomRemoved = 0;
    while (lines.length > 0 && bottomRemoved < HEADER_FOOTER_STRIP_CAP_PER_SIDE) {
      const candidate = lines[lines.length - 1].trim();
      if (candidate.length === 0) {
        lines.pop();
        continue;
      }
      if (
        candidate.length <= HEADER_FOOTER_MAX_LINE_LENGTH &&
        repeats.has(normaliseMargin(candidate))
      ) {
        lines.pop();
        bottomRemoved++;
        strippedCount++;
        continue;
      }
      break;
    }

    return { ...page, text: lines.join('\n').trim() };
  });

  return { entries, strippedCount, repeatedPatternCount: repeats.size };
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

  // Strip repeated running headers / footers / page numbers AFTER the
  // table-merge step so injected `<!-- table-start -->` blocks (which sit
  // at the bottom of the page entry) are never considered as candidates.
  const stripped = stripHeadersAndFooters(pageEntries);
  pageEntries = stripped.entries;
  if (stripped.strippedCount > 0) {
    metadata.headersFootersStripped = String(stripped.strippedCount);
    metadata.headerFooterPatterns = String(stripped.repeatedPatternCount);
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
