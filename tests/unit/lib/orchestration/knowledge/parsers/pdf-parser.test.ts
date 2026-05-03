/**
 * Unit Tests: PDF Parser (parsePdf)
 *
 * Tests the PDF document parser that uses pdf-parse (PDFParse class) to
 * extract text from digital-native PDF files. Scanned/image-only PDFs are
 * flagged with a warning.
 *
 * Test Coverage:
 * - Happy path: multi-page PDF with form-feed page separators
 * - Single-page PDF (no form-feed) → one untitled section
 * - Scanned PDF (no extractable text) → low-text warning
 * - Metadata extraction: title, author, page count
 * - Title falls back to filename when PDF info.Title is absent
 * - Empty sections are filtered out
 *
 * Key Behaviors:
 * - pdf-parse PDFParse class is mocked via vi.mock
 * - Form-feed characters (\f) separate pages; each non-empty page is a section
 * - Text shorter than 50 chars triggers the scanned-PDF warning
 * - metadata always includes format: "pdf"
 *
 * @see lib/orchestration/knowledge/parsers/pdf-parser.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mock pdf-parse so tests don't require real PDF files or the pdf.js engine.
 *
 * PDFParse is mocked as a class whose instances expose getText() and getInfo()
 * methods. Tests configure return values via mockGetText / mockGetInfo.
 */

const mockGetText = vi.fn();
const mockGetInfo = vi.fn();
const mockGetTable = vi.fn();

// PDFParse must be a proper constructor function (not an arrow function) so
// that `new PDFParse(...)` works at runtime.
function MockPDFParse() {
  // no-op — methods are on the prototype
}
MockPDFParse.prototype.getText = mockGetText;
MockPDFParse.prototype.getInfo = mockGetInfo;
MockPDFParse.prototype.getTable = mockGetTable;

vi.mock('pdf-parse', () => ({
  PDFParse: MockPDFParse,
}));

import { parsePdf } from '@/lib/orchestration/knowledge/parsers/pdf-parser';

// =============================================================================
// Helpers
// =============================================================================

/** Build a TextResult-like object that parsePdf expects from getText() */
function textResult(text: string) {
  return { text, pages: [] };
}

/**
 * Build a TextResult with structured per-page entries.
 * `pageTexts[i]` becomes the text for page i+1.
 */
function pagedResult(pageTexts: string[]) {
  return {
    text: pageTexts.join('\f'),
    pages: pageTexts.map((t, i) => ({ num: i + 1, text: t })),
  };
}

/** A page-text string of the given length (used to land above/below the 50-char threshold). */
function longPageText(chars = 200): string {
  return 'a'.repeat(chars);
}

/** Build an InfoResult-like object that parsePdf expects from getInfo() */
function infoResult(total = 1, info: Record<string, unknown> = {}) {
  return { total, info };
}

/** Create a minimal buffer (content is irrelevant — PDFParse is mocked) */
function fakeBuffer(): Buffer {
  return Buffer.from('fake pdf content');
}

// =============================================================================
// Test Suite
// =============================================================================

describe('parsePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock implementations — return minimal valid results
    mockGetText.mockResolvedValue(textResult(''));
    mockGetInfo.mockResolvedValue(infoResult());
    mockGetTable.mockResolvedValue({ pages: [] });
  });

  // ---------------------------------------------------------------------------
  // Multi-page PDFs
  // ---------------------------------------------------------------------------

  describe('Multi-page PDFs', () => {
    it('should create one section per page separated by form-feed characters', async () => {
      mockGetText.mockResolvedValue(
        textResult('Page one content.\fPage two content.\fPage three content.')
      );
      mockGetInfo.mockResolvedValue(infoResult(3));

      const result = await parsePdf(fakeBuffer(), 'multipage.pdf');

      expect(result.sections).toHaveLength(3);
      expect(result.sections[0].title).toBe('Page 1');
      expect(result.sections[0].content).toContain('Page one content.');
      expect(result.sections[1].title).toBe('Page 2');
      expect(result.sections[1].content).toContain('Page two content.');
      expect(result.sections[2].title).toBe('Page 3');
      expect(result.sections[2].content).toContain('Page three content.');
    });

    it('should assign ascending order values to page sections', async () => {
      mockGetText.mockResolvedValue(textResult('Page one.\fPage two.'));
      mockGetInfo.mockResolvedValue(infoResult(2));

      const result = await parsePdf(fakeBuffer(), 'pages.pdf');

      const orders = result.sections.map((s) => s.order);
      expect(orders).toEqual([0, 1]);
    });

    it('should filter out blank pages (form-feed followed by whitespace)', async () => {
      mockGetText.mockResolvedValue(textResult('Page one.\f   \fPage three.'));
      mockGetInfo.mockResolvedValue(infoResult(3));

      const result = await parsePdf(fakeBuffer(), 'blankpage.pdf');

      expect(result.sections).toHaveLength(2);
      expect(result.sections.some((s) => s.content.trim() === '')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Single-page PDFs
  // ---------------------------------------------------------------------------

  describe('Single-page PDF', () => {
    it('should produce one untitled section when there are no form-feed characters', async () => {
      const text = 'A long enough text on a single page for extraction purposes.';
      mockGetText.mockResolvedValue(textResult(text));
      mockGetInfo.mockResolvedValue(infoResult(1));

      const result = await parsePdf(fakeBuffer(), 'single.pdf');

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].title).toBe('');
      expect(result.sections[0].content).toContain(text);
    });
  });

  // ---------------------------------------------------------------------------
  // Scanned / image-only PDFs
  // ---------------------------------------------------------------------------

  describe('Scanned PDF detection', () => {
    it('should add a warning when extracted text is under the minimum viable length', async () => {
      mockGetText.mockResolvedValue(textResult('Short.'));

      const result = await parsePdf(fakeBuffer(), 'scanned.pdf');

      expect(result.warnings.some((w) => w.includes('scanned'))).toBe(true);
    });

    it('should not add the scanned warning when text is at or above 50 chars', async () => {
      const text = 'This sentence is long enough to pass the threshold.';
      mockGetText.mockResolvedValue(textResult(text));

      const result = await parsePdf(fakeBuffer(), 'ok.pdf');

      expect(result.warnings.some((w) => w.includes('scanned'))).toBe(false);
    });

    it('should add a warning for completely empty text', async () => {
      mockGetText.mockResolvedValue(textResult(''));

      const result = await parsePdf(fakeBuffer(), 'empty.pdf');

      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.sections).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Metadata extraction
  // ---------------------------------------------------------------------------

  describe('Metadata extraction', () => {
    it('should extract title from PDF info.Title', async () => {
      const text = 'Enough content to exceed the minimum viable text threshold here.';
      mockGetText.mockResolvedValue(textResult(text));
      mockGetInfo.mockResolvedValue(infoResult(1, { Title: 'My PDF Title' }));

      const result = await parsePdf(fakeBuffer(), 'meta.pdf');

      expect(result.title).toBe('My PDF Title');
      expect(result.metadata.title).toBe('My PDF Title');
    });

    it('should extract author from PDF info.Author', async () => {
      const text = 'Enough content to exceed the minimum viable text threshold here.';
      mockGetText.mockResolvedValue(textResult(text));
      mockGetInfo.mockResolvedValue(infoResult(1, { Author: 'Jane Smith' }));

      const result = await parsePdf(fakeBuffer(), 'authored.pdf');

      expect(result.author).toBe('Jane Smith');
      expect(result.metadata.author).toBe('Jane Smith');
    });

    it('should include page count in metadata when total is set', async () => {
      const text = 'Enough content to exceed the minimum viable text threshold here.';
      mockGetText.mockResolvedValue(textResult(text));
      mockGetInfo.mockResolvedValue(infoResult(42, {}));

      const result = await parsePdf(fakeBuffer(), 'pages.pdf');

      expect(result.metadata.pages).toBe('42');
    });

    it('should always include format: pdf in metadata', async () => {
      const text = 'Some text to exceed minimum threshold and avoid warning flags here.';
      mockGetText.mockResolvedValue(textResult(text));

      const result = await parsePdf(fakeBuffer(), 'format.pdf');

      expect(result.metadata.format).toBe('pdf');
    });

    it('should fall back to filename (without extension) when PDF has no title', async () => {
      const text = 'Enough content to exceed the minimum viable text threshold here.';
      mockGetText.mockResolvedValue(textResult(text));
      mockGetInfo.mockResolvedValue(infoResult(1, {}));

      const result = await parsePdf(fakeBuffer(), 'annual-report.pdf');

      expect(result.title).toBe('annual-report');
    });
  });

  // ---------------------------------------------------------------------------
  // fullText
  // ---------------------------------------------------------------------------

  describe('fullText', () => {
    it('should set fullText to the trimmed raw text from PDFParse', async () => {
      const text = '  Page one text.\fPage two text.  ';
      mockGetText.mockResolvedValue(textResult(text));
      mockGetInfo.mockResolvedValue(infoResult(2));

      const result = await parsePdf(fakeBuffer(), 'rawtext.pdf');

      // fullText should be the trimmed version of the raw text
      expect(result.fullText).toBe(text.trim());
    });
  });

  // ---------------------------------------------------------------------------
  // Per-page scanned diagnostic
  // ---------------------------------------------------------------------------

  describe('Per-page scanned-PDF diagnostic', () => {
    it('emits a single page warning naming the scanned page when only one is empty', async () => {
      mockGetText.mockResolvedValue(
        pagedResult([longPageText(), '', longPageText(), longPageText()])
      );
      mockGetInfo.mockResolvedValue(infoResult(4));

      const result = await parsePdf(fakeBuffer(), 'mostly-digital.pdf');

      const ranged = result.warnings.find((w) => w.includes('Page 2 of 4'));
      expect(ranged).toBeDefined();
      expect(ranged).toContain('produced no extractable text');
    });

    it('groups consecutive scanned pages into a single range warning', async () => {
      const pages = [
        longPageText(),
        longPageText(),
        longPageText(),
        '',
        '',
        '',
        '',
        longPageText(),
        longPageText(),
        longPageText(),
      ];
      mockGetText.mockResolvedValue(pagedResult(pages));
      mockGetInfo.mockResolvedValue(infoResult(10));

      const result = await parsePdf(fakeBuffer(), 'hybrid.pdf');

      const ranged = result.warnings.find((w) => w.includes('Pages 4–7 of 10'));
      expect(ranged).toBeDefined();
      expect(ranged).toContain('likely scanned');
    });

    it('emits no scanned warnings when every page has text', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText(), longPageText(), longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(3));

      const result = await parsePdf(fakeBuffer(), 'all-digital.pdf');

      expect(result.warnings.some((w) => w.includes('scanned'))).toBe(false);
    });

    it('falls back to the legacy doc-wide warning when EVERY page is empty', async () => {
      mockGetText.mockResolvedValue(pagedResult(['', '', '']));
      mockGetInfo.mockResolvedValue(infoResult(3));

      const result = await parsePdf(fakeBuffer(), 'all-scanned.pdf');

      const docWide = result.warnings.find((w) => w.includes('very little or no text'));
      expect(docWide).toBeDefined();
      // No per-range warnings when the whole document is empty.
      expect(result.warnings.some((w) => w.match(/^Page(s)? \d/))).toBe(false);
    });

    it('populates pageInfo with per-page char counts and hasText flags', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText(150), '', longPageText(80)]));
      mockGetInfo.mockResolvedValue(infoResult(3));

      const result = await parsePdf(fakeBuffer(), 'mixed.pdf');

      expect(result.pageInfo).toEqual([
        { num: 1, charCount: 150, hasText: true },
        { num: 2, charCount: 0, hasText: false },
        { num: 3, charCount: 80, hasText: true },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Opt-in table extraction
  // ---------------------------------------------------------------------------

  describe('Opt-in table extraction', () => {
    it('does not call getTable when extractTables is not set', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText(), longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(2));

      await parsePdf(fakeBuffer(), 'no-tables.pdf');

      expect(mockGetTable).not.toHaveBeenCalled();
    });

    it('appends fenced markdown tables to the matching page when extractTables is true', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText(), longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(2));
      mockGetTable.mockResolvedValue({
        pages: [
          {
            num: 2,
            tables: [
              [
                ['Item', 'Cost'],
                ['Widget', '£12.50'],
                ['Gizmo', '£8.00'],
              ],
            ],
          },
        ],
      });

      const result = await parsePdf(fakeBuffer(), 'tables.pdf', { extractTables: true });

      const page2 = result.sections.find((s) => s.title === 'Page 2');
      expect(page2).toBeDefined();
      expect(page2?.content).toContain('<!-- table-start -->');
      expect(page2?.content).toContain('| Item | Cost |');
      expect(page2?.content).toContain('| Widget | £12.50 |');
      expect(page2?.content).toContain('<!-- table-end -->');
    });

    it('escapes pipes and newlines inside cells', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(1));
      mockGetTable.mockResolvedValue({
        pages: [
          {
            num: 1,
            tables: [[['col|with|pipe', 'multi\nline']]],
          },
        ],
      });

      const result = await parsePdf(fakeBuffer(), 'escapes.pdf', { extractTables: true });

      expect(result.sections[0].content).toContain('col\\|with\\|pipe');
      expect(result.sections[0].content).toContain('multi line');
    });

    it('records the rendered-table count in metadata', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText(), longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(2));
      mockGetTable.mockResolvedValue({
        pages: [
          { num: 1, tables: [[['a', 'b']]] },
          { num: 2, tables: [[['c', 'd']], [['e', 'f']]] },
        ],
      });

      const result = await parsePdf(fakeBuffer(), 'multi.pdf', { extractTables: true });

      expect(result.metadata.tablesExtracted).toBe('3');
    });

    it('leaves pages untouched when getTable returns no tables', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(1));
      mockGetTable.mockResolvedValue({ pages: [{ num: 1, tables: [] }] });

      const result = await parsePdf(fakeBuffer(), 'no-detected.pdf', { extractTables: true });

      expect(result.sections[0].content).not.toContain('<!-- table-start -->');
      expect(result.metadata.tablesExtracted).toBeUndefined();
    });

    it('skips malformed page-table entries without a numeric num', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText(), longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(2));
      mockGetTable.mockResolvedValue({
        pages: [
          { tables: [[['x', 'y']]] }, // missing `num`
          { num: 2, tables: [[['real', 'row']]] },
        ],
      });

      const result = await parsePdf(fakeBuffer(), 'mixed.pdf', { extractTables: true });

      const page1 = result.sections.find((s) => s.title === 'Page 1');
      const page2 = result.sections.find((s) => s.title === 'Page 2');
      expect(page1?.content).not.toContain('<!-- table-start -->');
      expect(page2?.content).toContain('<!-- table-start -->');
      expect(result.metadata.tablesExtracted).toBe('1');
    });

    it('skips empty tables that render to no markdown', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(1));
      mockGetTable.mockResolvedValue({
        pages: [{ num: 1, tables: [[]] }],
      });

      const result = await parsePdf(fakeBuffer(), 'empty-table.pdf', { extractTables: true });

      expect(result.sections[0].content).not.toContain('<!-- table-start -->');
      expect(result.metadata.tablesExtracted).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases for per-page diagnostic ranges
  // ---------------------------------------------------------------------------

  describe('Per-page diagnostic edge cases', () => {
    it('warns when a leading page (page 1) is scanned', async () => {
      mockGetText.mockResolvedValue(pagedResult(['', longPageText(), longPageText()]));
      mockGetInfo.mockResolvedValue(infoResult(3));

      const result = await parsePdf(fakeBuffer(), 'leading.pdf');

      const warning = result.warnings.find((w) => w.includes('Page 1 of 3'));
      expect(warning).toBeDefined();
    });

    it('warns when trailing pages are scanned (range flushes after the loop)', async () => {
      mockGetText.mockResolvedValue(pagedResult([longPageText(), longPageText(), '', '']));
      mockGetInfo.mockResolvedValue(infoResult(4));

      const result = await parsePdf(fakeBuffer(), 'trailing.pdf');

      const warning = result.warnings.find((w) => w.includes('Pages 3–4 of 4'));
      expect(warning).toBeDefined();
    });

    it('uses pages[].num when present rather than the array index', async () => {
      // Simulate pdf-parse returning explicit page numbers (e.g. partial parse).
      mockGetText.mockResolvedValue({
        text: `${longPageText()}\f${longPageText()}`,
        pages: [
          { num: 5, text: longPageText() },
          { num: 6, text: longPageText() },
        ],
      });
      mockGetInfo.mockResolvedValue(infoResult(10));

      const result = await parsePdf(fakeBuffer(), 'partial.pdf');

      expect(result.sections.map((s) => s.title)).toEqual(['Page 5', 'Page 6']);
      expect(result.pageInfo?.[0].num).toBe(5);
    });

    it('treats undefined page text as an empty page', async () => {
      mockGetText.mockResolvedValue({
        text: longPageText(),
        pages: [
          { num: 1, text: undefined as unknown as string },
          { num: 2, text: longPageText() },
        ],
      });
      mockGetInfo.mockResolvedValue(infoResult(2));

      const result = await parsePdf(fakeBuffer(), 'undef.pdf');

      expect(result.pageInfo?.[0].hasText).toBe(false);
      expect(result.pageInfo?.[1].hasText).toBe(true);
    });
  });
});
