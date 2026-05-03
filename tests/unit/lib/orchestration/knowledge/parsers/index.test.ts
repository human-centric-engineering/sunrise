/**
 * Unit Tests: Document Parser Registry (parseDocument + requiresPreview)
 *
 * Tests the format router that dispatches file buffers to the correct
 * format-specific parser based on file extension, and the requiresPreview
 * helper that identifies formats needing a confirmation step.
 *
 * Test Coverage:
 * - .txt → parseTxt is called and its result is returned
 * - .md  → markdown passthrough (single section, format: markdown)
 * - .docx → parseDocx is called and its result is returned
 * - .pdf  → parsePdf is called and its result is returned
 * - Unsupported extension → throws "Unsupported document format" error
 * - requiresPreview(.pdf) → true
 * - requiresPreview(.txt / .md / .docx) → false
 * - Extension matching is case-insensitive
 *
 * Key Behaviors:
 * - logger.info is called twice per successful parse (before + after)
 * - epub-parser is imported but NOT tested here (requires filesystem)
 * - markdown files are handled inline without calling a separate parser
 *
 * @see lib/orchestration/knowledge/parsers/index.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedDocument } from '@/lib/orchestration/knowledge/parsers/types';

/**
 * Mock the logging module — avoids real I/O and lets us verify calls
 */
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * Mock individual parsers so we can verify routing without exercising
 * third-party library logic.
 */
vi.mock('@/lib/orchestration/knowledge/parsers/txt-parser', () => ({
  parseTxt: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/parsers/docx-parser', () => ({
  parseDocx: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/parsers/pdf-parser', () => ({
  parsePdf: vi.fn(),
}));

vi.mock('@/lib/orchestration/knowledge/parsers/epub-parser', () => ({
  parseEpub: vi.fn(),
}));

// Import the module under test AFTER the mocks are in place
import { parseDocument, requiresPreview } from '@/lib/orchestration/knowledge/parsers/index';
import { parseTxt } from '@/lib/orchestration/knowledge/parsers/txt-parser';
import { parseDocx } from '@/lib/orchestration/knowledge/parsers/docx-parser';
import { parsePdf } from '@/lib/orchestration/knowledge/parsers/pdf-parser';
import type { Mock } from 'vitest';

const mockParseTxt = parseTxt as Mock;
const mockParseDocx = parseDocx as Mock;
const mockParsePdf = parsePdf as Mock;

/**
 * Minimal ParsedDocument stub for mock return values
 */
function makeDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    title: 'Test Doc',
    sections: [{ title: '', content: 'Content', order: 0 }],
    fullText: 'Content',
    metadata: {},
    warnings: [],
    ...overrides,
  };
}

/**
 * Helper: create a buffer from a string
 */
function toBuffer(text = 'some content'): Buffer {
  return Buffer.from(text, 'utf-8');
}

// =============================================================================
// Test Suite: parseDocument
// =============================================================================

describe('parseDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // .txt routing
  // ---------------------------------------------------------------------------

  describe('.txt files', () => {
    it('should call parseTxt and return its result', async () => {
      const doc = makeDoc({ title: 'my-file', metadata: {} });
      mockParseTxt.mockReturnValue(doc);

      const buffer = toBuffer('Hello world');
      const result = await parseDocument(buffer, 'my-file.txt');

      expect(mockParseTxt).toHaveBeenCalledWith(buffer, 'my-file.txt');
      expect(result).toEqual(doc);
    });
  });

  // ---------------------------------------------------------------------------
  // .md routing (inline passthrough)
  // ---------------------------------------------------------------------------

  describe('.md files', () => {
    it('should return the markdown content as a single untitled section', async () => {
      const content = '# Heading\n\nBody text.';
      const buffer = toBuffer(content);

      const result = await parseDocument(buffer, 'notes.md');

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].title).toBe('');
      expect(result.sections[0].content).toBe(content);
      expect(result.sections[0].order).toBe(0);
    });

    it('should set metadata.format to "markdown"', async () => {
      const result = await parseDocument(toBuffer('# Hello'), 'notes.md');

      expect(result.metadata.format).toBe('markdown');
    });

    it('should set title to the filename without extension', async () => {
      const result = await parseDocument(toBuffer('content'), 'my-notes.md');

      expect(result.title).toBe('my-notes');
    });

    it('should set fullText to the raw markdown string', async () => {
      const content = '# Title\n\nParagraph.';
      const result = await parseDocument(toBuffer(content), 'page.md');

      expect(result.fullText).toBe(content);
    });

    it('should not call parseTxt, parseDocx, or parsePdf for markdown', async () => {
      await parseDocument(toBuffer('# Hello'), 'doc.md');

      // test-review:accept clear_then_notcalled — clearAllMocks is in beforeEach (not mid-test); not.toHaveBeenCalled verifies correct parser routing
      expect(mockParseTxt).not.toHaveBeenCalled();
      expect(mockParseDocx).not.toHaveBeenCalled();
      expect(mockParsePdf).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // .docx routing
  // ---------------------------------------------------------------------------

  describe('.docx files', () => {
    it('should call parseDocx and return its result', async () => {
      const doc = makeDoc({ title: 'report', metadata: { format: 'docx' } });
      mockParseDocx.mockResolvedValue(doc);

      const buffer = toBuffer();
      const result = await parseDocument(buffer, 'report.docx');

      expect(mockParseDocx).toHaveBeenCalledWith(buffer, 'report.docx');
      expect(result).toEqual(doc);
    });
  });

  // ---------------------------------------------------------------------------
  // .pdf routing
  // ---------------------------------------------------------------------------

  describe('.pdf files', () => {
    it('should call parsePdf and return its result', async () => {
      const doc = makeDoc({ title: 'whitepaper', metadata: { format: 'pdf' } });
      mockParsePdf.mockResolvedValue(doc);

      const buffer = toBuffer();
      const result = await parseDocument(buffer, 'whitepaper.pdf');

      expect(mockParsePdf).toHaveBeenCalledWith(buffer, 'whitepaper.pdf', {
        extractTables: undefined,
      });
      expect(result).toEqual(doc);
    });

    it('forwards extractTables when provided', async () => {
      const doc = makeDoc({ title: 'tables', metadata: { format: 'pdf' } });
      mockParsePdf.mockResolvedValue(doc);

      const buffer = toBuffer();
      await parseDocument(buffer, 'tables.pdf', { extractTables: true });

      expect(mockParsePdf).toHaveBeenCalledWith(buffer, 'tables.pdf', {
        extractTables: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Unsupported formats
  // ---------------------------------------------------------------------------

  describe('Unsupported formats', () => {
    it('should throw an error for .xls files', async () => {
      await expect(parseDocument(toBuffer(), 'data.xls')).rejects.toThrow(
        'Unsupported document format: .xls'
      );
    });

    it('should throw an error for .pptx files', async () => {
      await expect(parseDocument(toBuffer(), 'slides.pptx')).rejects.toThrow(
        'Unsupported document format: .pptx'
      );
    });

    it('should throw an error for files with no extension', async () => {
      await expect(parseDocument(toBuffer(), 'README')).rejects.toThrow(
        'Unsupported document format'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Case-insensitive extension matching
  // ---------------------------------------------------------------------------

  describe('Case-insensitive extension matching', () => {
    it('should accept .PDF (uppercase) and route to parsePdf', async () => {
      const doc = makeDoc();
      mockParsePdf.mockResolvedValue(doc);

      const buffer = toBuffer();
      await parseDocument(buffer, 'DOCUMENT.PDF');

      expect(mockParsePdf).toHaveBeenCalledWith(buffer, 'DOCUMENT.PDF', {
        extractTables: undefined,
      });
    });

    it('should accept .TXT (uppercase) and route to parseTxt', async () => {
      const doc = makeDoc();
      mockParseTxt.mockReturnValue(doc);

      const buffer = toBuffer();
      await parseDocument(buffer, 'NOTES.TXT');

      expect(mockParseTxt).toHaveBeenCalledWith(buffer, 'NOTES.TXT');
    });
  });
});

// =============================================================================
// Test Suite: requiresPreview
// =============================================================================

describe('requiresPreview', () => {
  it('should return true for .pdf files', () => {
    expect(requiresPreview('document.pdf')).toBe(true);
  });

  it('should return true for .PDF (uppercase)', () => {
    expect(requiresPreview('DOCUMENT.PDF')).toBe(true);
  });

  it('should return false for .txt files', () => {
    expect(requiresPreview('notes.txt')).toBe(false);
  });

  it('should return false for .md files', () => {
    expect(requiresPreview('readme.md')).toBe(false);
  });

  it('should return false for .docx files', () => {
    expect(requiresPreview('report.docx')).toBe(false);
  });

  it('should return false for .epub files', () => {
    expect(requiresPreview('book.epub')).toBe(false);
  });

  it('should return false for unsupported extensions', () => {
    expect(requiresPreview('data.xls')).toBe(false);
  });
});
