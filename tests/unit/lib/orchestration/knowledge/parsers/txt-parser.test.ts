/**
 * Unit Tests: Plain Text Parser (parseTxt)
 *
 * Tests the plain-text document parser that splits content into sections
 * using blank-line boundaries and heading detection heuristics.
 *
 * Test Coverage:
 * - Basic paragraph splitting on blank lines
 * - ALL CAPS heading detection as section boundaries
 * - Underline-style headings (=== and --- markers)
 * - Empty buffer → empty sections array
 * - Single paragraph with no headings → one untitled section
 * - Filename used as document title (extension stripped)
 *
 * Key Behaviors:
 * - ALL CAPS lines (≥3 chars, ≥60% letters) trigger a new section
 * - Lines followed by ===+ or ---+ underlines are treated as headings
 * - Empty content sections are discarded
 * - If no sections are detected from headings, the entire text becomes one section
 *
 * @see lib/orchestration/knowledge/parsers/txt-parser.ts
 */

import { describe, it, expect } from 'vitest';
import { parseTxt } from '@/lib/orchestration/knowledge/parsers/txt-parser';

/**
 * Helper: convert a plain string to a Buffer as the parser expects
 */
function toBuffer(text: string): Buffer {
  return Buffer.from(text, 'utf-8');
}

// =============================================================================
// Test Suite
// =============================================================================

describe('parseTxt', () => {
  // ---------------------------------------------------------------------------
  // Document title
  // ---------------------------------------------------------------------------

  describe('Document title', () => {
    it('should strip the file extension and use the base name as title', () => {
      const result = parseTxt(toBuffer('Hello world'), 'my-document.txt');
      expect(result.title).toBe('my-document');
    });

    it('should handle filenames without extensions', () => {
      const result = parseTxt(toBuffer('Hello world'), 'readme');
      expect(result.title).toBe('readme');
    });
  });

  // ---------------------------------------------------------------------------
  // Empty input
  // ---------------------------------------------------------------------------

  describe('Empty input', () => {
    it('should return empty sections and empty fullText for an empty buffer', () => {
      const result = parseTxt(toBuffer(''), 'empty.txt');

      expect(result.sections).toHaveLength(0);
      expect(result.fullText).toBe('');
      expect(result.warnings).toEqual([]);
    });

    it('should return empty sections for a whitespace-only buffer', () => {
      const result = parseTxt(toBuffer('   \n\n\t\n   '), 'whitespace.txt');

      expect(result.sections).toHaveLength(0);
      expect(result.fullText).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // Single paragraph (no headings)
  // ---------------------------------------------------------------------------

  describe('Single paragraph', () => {
    it('should produce one untitled section when there are no heading markers', () => {
      const text = 'This is a single paragraph with no headings.';
      const result = parseTxt(toBuffer(text), 'single.txt');

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].title).toBe('');
      expect(result.sections[0].content).toBe(text);
      expect(result.sections[0].order).toBe(0);
    });

    it('should produce one section for multi-line text with no headings', () => {
      const text = 'Line one.\nLine two.\nLine three.';
      const result = parseTxt(toBuffer(text), 'multiline.txt');

      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].content).toContain('Line one.');
      expect(result.sections[0].content).toContain('Line three.');
    });

    it('should set fullText to the trimmed content of the single section', () => {
      const text = 'Just one paragraph here.';
      const result = parseTxt(toBuffer(text), 'para.txt');

      expect(result.fullText).toContain('Just one paragraph here.');
    });
  });

  // ---------------------------------------------------------------------------
  // ALL CAPS heading detection
  // ---------------------------------------------------------------------------

  describe('ALL CAPS heading detection', () => {
    it('should split on an ALL CAPS line encountered mid-content', () => {
      const text = ['Introduction text here.', '', 'CHAPTER ONE', 'Content for chapter one.'].join(
        '\n'
      );

      const result = parseTxt(toBuffer(text), 'caps.txt');

      // Should have at least 2 sections: intro and the chapter
      expect(result.sections.length).toBeGreaterThanOrEqual(2);

      const chapterSection = result.sections.find((s) => s.title === 'CHAPTER ONE');
      expect(chapterSection).toBeDefined();
      expect(chapterSection?.content).toContain('Content for chapter one.');
    });

    it('should use the ALL CAPS line as the section title', () => {
      const text = ['Some intro text.', 'MAIN HEADING', 'Body content.'].join('\n');

      const result = parseTxt(toBuffer(text), 'heading.txt');

      const section = result.sections.find((s) => s.title === 'MAIN HEADING');
      expect(section).toBeDefined();
    });

    it('should not treat short ALL CAPS words (under 3 chars) as headings', () => {
      // "OK" is only 2 chars — should not split
      const text = ['First paragraph.', 'OK', 'Second paragraph.'].join('\n');

      const result = parseTxt(toBuffer(text), 'short-caps.txt');

      // All content should be in a single section since "OK" is too short
      expect(result.sections).toHaveLength(1);
    });

    it('should not treat lines where letters are less than 60% of characters as headings', () => {
      // "123 456" — mostly numbers, not letters-dominant
      const text = ['First paragraph.', '123 456 789', 'Second paragraph.'].join('\n');

      const result = parseTxt(toBuffer(text), 'numbers.txt');

      expect(result.sections).toHaveLength(1);
    });

    it('should assign ascending order values to sections', () => {
      const text = [
        'Intro content.',
        'FIRST SECTION',
        'First body.',
        'SECOND SECTION',
        'Second body.',
      ].join('\n');

      const result = parseTxt(toBuffer(text), 'ordered.txt');

      // Sections should have sequential order values starting at 0
      const orders = result.sections.map((s) => s.order);
      expect(orders).toEqual([...Array(result.sections.length).keys()]);
    });
  });

  // ---------------------------------------------------------------------------
  // Underline-style headings (=== and ---)
  // ---------------------------------------------------------------------------

  describe('Underline-style headings', () => {
    it('should detect === underline-style headings and use the preceding line as title', () => {
      const text = ['First Section', '============', 'Content under first section.'].join('\n');

      const result = parseTxt(toBuffer(text), 'underline.txt');

      const section = result.sections.find((s) => s.title === 'First Section');
      expect(section).toBeDefined();
      expect(section?.content).toContain('Content under first section.');
    });

    it('should detect --- underline-style headings and use the preceding line as title', () => {
      const text = ['Second Section', '--------------', 'Content under second section.'].join('\n');

      const result = parseTxt(toBuffer(text), 'dash-underline.txt');

      const section = result.sections.find((s) => s.title === 'Second Section');
      expect(section).toBeDefined();
      expect(section?.content).toContain('Content under second section.');
    });

    it('should handle documents with multiple underline headings', () => {
      const text = [
        'Chapter One',
        '===========',
        'Content of chapter one.',
        '',
        'Chapter Two',
        '-----------',
        'Content of chapter two.',
      ].join('\n');

      const result = parseTxt(toBuffer(text), 'multi-underline.txt');

      const titles = result.sections.map((s) => s.title);
      expect(titles).toContain('Chapter One');
      expect(titles).toContain('Chapter Two');
    });

    it('should require at least 3 underline characters', () => {
      // Only 2 dashes — not a valid underline
      const text = ['Not a heading', '--', 'Regular content.'].join('\n');

      const result = parseTxt(toBuffer(text), 'short-underline.txt');

      // Should not split on the short dashes
      expect(result.sections.every((s) => s.title !== 'Not a heading')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // fullText and metadata
  // ---------------------------------------------------------------------------

  describe('Output structure', () => {
    it('should set fullText to the joined content of all sections', () => {
      const text = ['Intro text here.', 'MAIN SECTION', 'Main body content.'].join('\n');

      const result = parseTxt(toBuffer(text), 'fulltext.txt');

      expect(result.fullText).toContain('Intro text here.');
      expect(result.fullText).toContain('Main body content.');
    });

    it('should return an empty warnings array', () => {
      const result = parseTxt(toBuffer('Some text.'), 'nowarn.txt');
      expect(result.warnings).toEqual([]);
    });

    it('should return metadata with format txt', () => {
      const result = parseTxt(toBuffer('Some text.'), 'meta.txt');
      expect(result.metadata).toEqual({ format: 'txt' });
    });
  });
});
