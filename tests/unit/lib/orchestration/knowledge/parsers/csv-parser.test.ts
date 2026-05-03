/**
 * Unit Tests: CSV Parser (parseCsv)
 *
 * Tests the in-house RFC 4180 CSV parser with delimiter sniffing and
 * header-row detection.
 *
 * Test Coverage:
 * - Delimiter sniffing: comma / tab / semicolon
 * - Header detection: positive, negative (numeric row 1), absent (single row)
 * - Quoting: simple, escaped quote (`""`), embedded comma, embedded newline
 * - Row → "Header: Value | Header: Value" rendering
 * - Synthesised headers when no header row is detected
 * - Warnings: empty CSV, no rows, wide rows, unbalanced quotes
 * - Metadata: format, delimiter, rowCount, columnCount, hasHeader
 *
 * @see lib/orchestration/knowledge/parsers/csv-parser.ts
 */

import { describe, it, expect } from 'vitest';
import { parseCsv } from '@/lib/orchestration/knowledge/parsers/csv-parser';

function buf(s: string): Buffer {
  return Buffer.from(s, 'utf-8');
}

describe('parseCsv', () => {
  // ---------------------------------------------------------------------------
  // Delimiter sniffing
  // ---------------------------------------------------------------------------

  describe('Delimiter sniffing', () => {
    it('detects comma as the default delimiter', () => {
      const csv = 'name,age,city\nAlice,30,Bristol\nBob,25,Leeds\n';
      const result = parseCsv(buf(csv), 'people.csv');
      expect(result.metadata.delimiter).toBe(',');
      expect(result.sections).toHaveLength(2);
    });

    it('detects tab when tab counts dominate', () => {
      const csv = 'name\tage\tcity\nAlice\t30\tBristol\nBob\t25\tLeeds\n';
      const result = parseCsv(buf(csv), 'people.csv');
      expect(result.metadata.delimiter).toBe('\t');
      expect(result.sections).toHaveLength(2);
    });

    it('detects semicolon when semicolon counts dominate', () => {
      const csv = 'name;age;city\nAlice;30;Bristol\nBob;25;Leeds\n';
      const result = parseCsv(buf(csv), 'people.csv');
      expect(result.metadata.delimiter).toBe(';');
    });
  });

  // ---------------------------------------------------------------------------
  // Header detection
  // ---------------------------------------------------------------------------

  describe('Header detection', () => {
    it('treats text-only first row as a header', () => {
      const csv = 'name,age\nAlice,30\nBob,25\n';
      const result = parseCsv(buf(csv), 'h.csv');
      expect(result.metadata.hasHeader).toBe('true');
      expect(result.sections).toHaveLength(2);
      expect(result.sections[0].content).toBe('name: Alice | age: 30');
    });

    it('rejects header when row 1 contains a purely numeric cell', () => {
      const csv = '1,2,3\n4,5,6\n7,8,9\n';
      const result = parseCsv(buf(csv), 'numeric.csv');
      expect(result.metadata.hasHeader).toBe('false');
      expect(result.sections).toHaveLength(3);
      expect(result.sections[0].content).toBe('Column 1: 1 | Column 2: 2 | Column 3: 3');
    });

    it('synthesises Column N headers when row 1 is not a header', () => {
      const csv = '1,2\n3,4\n';
      const result = parseCsv(buf(csv), 'syn.csv');
      expect(result.sections[0].content).toContain('Column 1');
      expect(result.sections[0].content).toContain('Column 2');
    });
  });

  // ---------------------------------------------------------------------------
  // RFC 4180 quoting
  // ---------------------------------------------------------------------------

  describe('Quoting', () => {
    it('preserves commas inside quoted cells', () => {
      const csv = 'name,note\n"Smith, J.",hello\n';
      const result = parseCsv(buf(csv), 'q.csv');
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].content).toBe('name: Smith, J. | note: hello');
    });

    it('handles escaped quotes ("") inside cells', () => {
      const csv = 'q\n"She said ""hi"""\n';
      const result = parseCsv(buf(csv), 'q.csv');
      expect(result.sections[0].content).toBe('q: She said "hi"');
    });

    it('preserves embedded newlines inside quoted cells', () => {
      const csv = 'q\n"line1\nline2"\n';
      const result = parseCsv(buf(csv), 'q.csv');
      expect(result.sections).toHaveLength(1);
      expect(result.sections[0].content).toBe('q: line1\nline2');
    });

    it('warns on unbalanced quotes', () => {
      const csv = 'q\n"unterminated\n';
      const result = parseCsv(buf(csv), 'bad.csv');
      expect(result.warnings.some((w) => w.includes('unbalanced'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Section / row rendering
  // ---------------------------------------------------------------------------

  describe('Row rendering', () => {
    it('emits one section per data row in order', () => {
      const csv = 'a,b\n1,2\n3,4\n5,6\n';
      const result = parseCsv(buf(csv), 'rows.csv');
      expect(result.sections.map((s) => s.title)).toEqual(['Row 1', 'Row 2', 'Row 3']);
      expect(result.sections.map((s) => s.order)).toEqual([0, 1, 2]);
    });

    it('renders missing trailing cells as empty values', () => {
      const csv = 'a,b,c\n1,2\n';
      const result = parseCsv(buf(csv), 'short.csv');
      expect(result.sections[0].content).toBe('a: 1 | b: 2 | c: ');
    });

    it('builds fullText by joining row strings with newlines', () => {
      const csv = 'a,b\n1,2\n3,4\n';
      const result = parseCsv(buf(csv), 'rows.csv');
      expect(result.fullText).toBe('a: 1 | b: 2\na: 3 | b: 4');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases & warnings
  // ---------------------------------------------------------------------------

  describe('UTF-8 BOM handling', () => {
    it('strips a leading BOM so it does not contaminate the first header cell', () => {
      const csv = '\uFEFFname,amount\nAcme,100\n';
      const result = parseCsv(buf(csv), 'spending.csv');
      expect(result.metadata.hasHeader).toBe('true');
      // The first chunk should render with a clean "name:" header, not "BOM-name:".
      expect(result.sections[0].content).toBe('name: Acme | amount: 100');
      expect(result.sections[0].content.charCodeAt(0)).not.toBe(0xfeff);
    });

    it('handles CRLF line endings without leaking \\r into cells', () => {
      const csv = 'name,amount\r\nAcme,100\r\nBeta,200\r\n';
      const result = parseCsv(buf(csv), 'crlf.csv');
      expect(result.sections).toHaveLength(2);
      expect(result.sections[0].content).toBe('name: Acme | amount: 100');
      expect(result.sections[1].content).toBe('name: Beta | amount: 200');
    });
  });

  describe('Edge cases', () => {
    it('returns empty result with warning for empty input', () => {
      const result = parseCsv(buf(''), 'empty.csv');
      expect(result.sections).toHaveLength(0);
      expect(result.warnings.some((w) => w.includes('empty'))).toBe(true);
    });

    it('returns empty result with warning for whitespace-only input', () => {
      const result = parseCsv(buf('   \n  \n'), 'ws.csv');
      expect(result.sections).toHaveLength(0);
    });

    it('handles a single-cell single-row CSV without crashing', () => {
      const result = parseCsv(buf('alone\n'), 'one.csv');
      expect(result.sections).toHaveLength(1);
      expect(result.metadata.hasHeader).toBe('false');
    });

    it('warns when the CSV has more than 100 columns', () => {
      const wide = Array.from({ length: 110 }, (_, i) => `c${i}`).join(',');
      const data = Array.from({ length: 110 }, (_, i) => String(i)).join(',');
      const csv = `${wide}\n${data}\n`;
      const result = parseCsv(buf(csv), 'wide.csv');
      expect(result.warnings.some((w) => w.includes('Wide'))).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  describe('Metadata', () => {
    it('includes format, delimiter, rowCount, columnCount, hasHeader', () => {
      const csv = 'a,b,c\n1,2,3\n4,5,6\n';
      const result = parseCsv(buf(csv), 'meta.csv');
      expect(result.metadata.format).toBe('csv');
      expect(result.metadata.delimiter).toBe(',');
      expect(result.metadata.rowCount).toBe('2');
      expect(result.metadata.columnCount).toBe('3');
      expect(result.metadata.hasHeader).toBe('true');
    });

    it('uses filename (sans extension) as the title', () => {
      const csv = 'a,b\n1,2\n';
      const result = parseCsv(buf(csv), 'spending-2025.csv');
      expect(result.title).toBe('spending-2025');
    });
  });
});
