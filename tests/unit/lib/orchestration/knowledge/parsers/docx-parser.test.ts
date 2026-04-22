/**
 * Unit Tests: DOCX Parser (parseDocx)
 *
 * Tests the Word document parser that uses mammoth to convert DOCX to
 * markdown, then splits the result into sections on heading markers.
 *
 * Test Coverage:
 * - Happy path: markdown with headings splits into correct sections
 * - Document title taken from first heading when present
 * - Document title falls back to filename when no headings exist
 * - Empty / whitespace-only mammoth output → empty sections + warning
 * - mammoth warning messages are collected and prefixed with "DOCX:"
 * - Single-section document (content with no headings)
 * - Headings at levels #, ##, ### all trigger section splits
 *
 * Key Behaviors:
 * - mammoth.convertToMarkdown is called with the raw buffer
 * - Markdown headings (# / ## / ###) become ParsedSection titles
 * - content before the first heading is an untitled section (order 0)
 * - metadata.format is always "docx"
 *
 * @see lib/orchestration/knowledge/parsers/docx-parser.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/**
 * Mock mammoth before importing the parser under test.
 *
 * mammoth is an ES-module default export. We expose convertToMarkdown
 * as a vi.fn() so individual tests can configure return values.
 */
vi.mock('mammoth', () => ({
  default: {
    convertToMarkdown: vi.fn(),
  },
}));

import mammoth from 'mammoth';
import { parseDocx } from '@/lib/orchestration/knowledge/parsers/docx-parser';

// Typed handle for the mock
const mockConvertToMarkdown = mammoth.convertToMarkdown as Mock;

/**
 * Helper: build the shape mammoth.convertToMarkdown resolves with
 */
function mammothResult(value: string, messages: Array<{ type: string; message: string }> = []) {
  return { value, messages };
}

/**
 * Helper: create a minimal buffer (content does not matter — mammoth is mocked)
 */
function fakeBuffer(): Buffer {
  return Buffer.from('fake docx content');
}

// =============================================================================
// Test Suite
// =============================================================================

describe('parseDocx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Empty / blank document
  // ---------------------------------------------------------------------------

  describe('Empty document', () => {
    it('should return empty sections and a warning when mammoth produces no text', async () => {
      mockConvertToMarkdown.mockResolvedValue(mammothResult(''));

      const result = await parseDocx(fakeBuffer(), 'empty.docx');

      expect(result.sections).toHaveLength(0);
      expect(result.fullText).toBe('');
      expect(result.warnings).toContain('Document produced no text content');
    });

    it('should return empty sections when mammoth returns only whitespace', async () => {
      mockConvertToMarkdown.mockResolvedValue(mammothResult('   \n\n   '));

      const result = await parseDocx(fakeBuffer(), 'blank.docx');

      expect(result.sections).toHaveLength(0);
      expect(result.warnings).toContain('Document produced no text content');
    });

    it('should use filename (without extension) as title for empty document', async () => {
      mockConvertToMarkdown.mockResolvedValue(mammothResult(''));

      const result = await parseDocx(fakeBuffer(), 'my-report.docx');

      expect(result.title).toBe('my-report');
    });

    it('should always include format: docx in metadata', async () => {
      mockConvertToMarkdown.mockResolvedValue(mammothResult(''));

      const result = await parseDocx(fakeBuffer(), 'doc.docx');

      expect(result.metadata).toMatchObject({ format: 'docx' });
    });
  });

  // ---------------------------------------------------------------------------
  // Warning propagation
  // ---------------------------------------------------------------------------

  describe('Warning propagation', () => {
    it('should collect mammoth warning messages prefixed with "DOCX:"', async () => {
      mockConvertToMarkdown.mockResolvedValue(
        mammothResult('Some content here.', [
          { type: 'warning', message: 'Unsupported image type' },
          { type: 'warning', message: 'Complex table simplified' },
        ])
      );

      const result = await parseDocx(fakeBuffer(), 'warnings.docx');

      expect(result.warnings).toContain('DOCX: Unsupported image type');
      expect(result.warnings).toContain('DOCX: Complex table simplified');
    });

    it('should not add non-warning messages to the warnings array', async () => {
      mockConvertToMarkdown.mockResolvedValue(
        mammothResult('Content here.', [{ type: 'info', message: 'Converted successfully' }])
      );

      const result = await parseDocx(fakeBuffer(), 'info-msg.docx');

      // info messages should not appear in warnings
      expect(result.warnings.some((w) => w.includes('Converted successfully'))).toBe(false);
    });

    it('should include warnings even when the document has content', async () => {
      mockConvertToMarkdown.mockResolvedValue(
        mammothResult('# Heading\n\nBody text.', [
          { type: 'warning', message: 'Embedded font ignored' },
        ])
      );

      const result = await parseDocx(fakeBuffer(), 'withwarn.docx');

      expect(result.sections.length).toBeGreaterThan(0);
      expect(result.warnings).toContain('DOCX: Embedded font ignored');
    });
  });

  // ---------------------------------------------------------------------------
  // Heading-based section splitting
  // ---------------------------------------------------------------------------

  describe('Heading-based section splitting', () => {
    it('should split on # (h1) headings and use the heading text as section title', async () => {
      const markdown = '# Introduction\n\nIntro body here.\n\n# Conclusion\n\nConclusion body.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'h1.docx');

      const titles = result.sections.map((s) => s.title);
      expect(titles).toContain('Introduction');
      expect(titles).toContain('Conclusion');
    });

    it('should split on ## (h2) headings', async () => {
      const markdown = '## Section A\n\nContent A.\n\n## Section B\n\nContent B.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'h2.docx');

      const titles = result.sections.map((s) => s.title);
      expect(titles).toContain('Section A');
      expect(titles).toContain('Section B');
    });

    it('should split on ### (h3) headings', async () => {
      const markdown = '### Sub-section\n\nSub content.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'h3.docx');

      const titles = result.sections.map((s) => s.title);
      expect(titles).toContain('Sub-section');
    });

    it('should preserve section content under each heading', async () => {
      const markdown =
        '## Chapter One\n\nThis is chapter one content.\n\n## Chapter Two\n\nThis is chapter two content.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'chapters.docx');

      const chapter1 = result.sections.find((s) => s.title === 'Chapter One');
      const chapter2 = result.sections.find((s) => s.title === 'Chapter Two');

      expect(chapter1?.content).toContain('chapter one content');
      expect(chapter2?.content).toContain('chapter two content');
    });

    it('should capture content before the first heading as an untitled section', async () => {
      const markdown = 'Preamble text before any heading.\n\n# First Heading\n\nBody text.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'preamble.docx');

      const untitled = result.sections.find((s) => s.title === '');
      expect(untitled).toBeDefined();
      expect(untitled?.content).toContain('Preamble text before any heading.');
    });

    it('should assign ascending order values to sections', async () => {
      const markdown = '# First\n\nContent.\n\n## Second\n\nMore content.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'ordered.docx');

      const orders = result.sections.map((s) => s.order);
      expect(orders).toEqual([...Array(result.sections.length).keys()]);
    });
  });

  // ---------------------------------------------------------------------------
  // Document title
  // ---------------------------------------------------------------------------

  describe('Document title', () => {
    it('should use the first heading text as document title', async () => {
      const markdown = '# My Document Title\n\nBody text.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'doc.docx');

      expect(result.title).toBe('My Document Title');
    });

    it('should fall back to filename (without extension) when there is no heading', async () => {
      const markdown = 'Plain body text with no headings.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'quarterly-report.docx');

      expect(result.title).toBe('quarterly-report');
    });
  });

  // ---------------------------------------------------------------------------
  // fullText
  // ---------------------------------------------------------------------------

  describe('fullText', () => {
    it('should join all section content into fullText', async () => {
      const markdown = '# Part One\n\nFirst part content.\n\n# Part Two\n\nSecond part content.';
      mockConvertToMarkdown.mockResolvedValue(mammothResult(markdown));

      const result = await parseDocx(fakeBuffer(), 'full.docx');

      expect(result.fullText).toContain('First part content.');
      expect(result.fullText).toContain('Second part content.');
    });
  });
});
