/**
 * Unit Tests: csvEscape
 *
 * @see lib/api/csv.ts
 */

import { describe, it, expect } from 'vitest';

import { csvEscape } from '@/lib/api/csv';
import { parseCsvRecords } from '@/tests/helpers/csv';

describe('csvEscape', () => {
  describe('RFC 4180 quoting', () => {
    it('passes through plain alphanumeric text', () => {
      expect(csvEscape('hello world')).toBe('hello world');
    });

    it('wraps values containing commas in double quotes', () => {
      expect(csvEscape('a,b,c')).toBe('"a,b,c"');
    });

    it('wraps values containing newlines in double quotes', () => {
      expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    });

    it('wraps values containing a lone carriage return in double quotes', () => {
      expect(csvEscape('line1\rline2')).toBe('"line1\rline2"');
    });

    it('wraps values containing CRLF in double quotes', () => {
      expect(csvEscape('line1\r\nline2')).toBe('"line1\r\nline2"');
    });

    // Only the lone-CR case failed before #768; LF and CRLF guard
    // behaviour that already worked.
    it.each(['\r\n', '\r', '\n'])(
      'does not let an interior line break (%j) start a record of its own',
      (sep) => {
        const cell = csvEscape(`thanks!${sep}=SUM(A1:A2)`);
        const csv = ['a,b', [cell, 'x'].join(',')].join(sep);
        expect(parseCsvRecords(csv)).toEqual([
          ['a', 'b'],
          [`thanks!${sep}=SUM(A1:A2)`, 'x'],
        ]);
      }
    );

    it('keeps a mid-cell CR inside its record so it cannot open a new cell (#768)', () => {
      // No comma or quote, so only the CR can trigger quoting. A
      // spreadsheet treats a bare CR as a record break. Unquoted, the
      // text after it would land in column A of a new record, where its
      // first character escapes the leading-character neutraliser.
      const cell = csvEscape("thanks!\r=cmd|' /C calc'!A0");
      const csv = ['a,b', [cell, 'x'].join(',')].join('\r\n');

      const records = parseCsvRecords(csv);
      expect(records).toEqual([
        ['a', 'b'],
        ["thanks!\r=cmd|' /C calc'!A0", 'x'],
      ]);
    });

    it('doubles internal quotes and wraps in outer quotes', () => {
      expect(csvEscape('she said "hi"')).toBe('"she said ""hi"""');
    });

    it('handles empty strings without prefixing', () => {
      expect(csvEscape('')).toBe('');
    });
  });

  describe('formula-injection neutralisation', () => {
    // The injection class CSV exporters historically miss. Each of
    // these characters at the start of a cell makes Excel / LibreOffice
    // / Google Sheets evaluate the value as a formula on open.
    it.each([
      ["=cmd|'/c calc.exe'!A1", "'=cmd|'/c calc.exe'!A1"],
      ['+SUM(A1:A2)', "'+SUM(A1:A2)"],
      ['-2+3', "'-2+3"],
      ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
      ['\tfoo', "'\tfoo"],
    ])('prefixes a single quote when value starts with a formula trigger', (input, expected) => {
      // Each of the above values has no comma/quote/newline, so the
      // RFC 4180 wrapping does not fire. We just see the leading
      // single-quote injection-marker that spreadsheets render as a
      // text indicator and strip on read.
      expect(csvEscape(input)).toBe(expected);
    });

    it('applies neutralisation AND wraps when the trigger value also needs RFC 4180 quoting', () => {
      // A HYPERLINK-style payload contains literal quotes — both the
      // formula-injection neutraliser and the comma/quote wrapper need
      // to fire. The neutraliser runs first; the wrapper then sees the
      // leading-quoted string, escapes its internal `"` runs, and
      // wraps the whole thing.
      const input = '=HYPERLINK("https://evil.example","click")';
      expect(csvEscape(input)).toBe('"\'=HYPERLINK(""https://evil.example"",""click"")"');
    });

    it('neutralises AND quotes a leading carriage return', () => {
      // \r is a formula trigger on its own, and also a record separator
      // to a spreadsheet, so both the prefix and the RFC 4180 wrap fire.
      expect(csvEscape('\rfoo')).toBe('"\'\rfoo"');
    });

    it('applies BOTH neutralisation AND quoting when the value also contains a comma', () => {
      // Neutraliser fires first; the resulting string then needs RFC
      // 4180 wrapping because the comma is still present.
      expect(csvEscape('=A1,B1')).toBe('"\'=A1,B1"');
    });

    it('does not double-escape neutralised values on subsequent calls', () => {
      // Idempotence check — calling twice should keep the original
      // neutralisation rather than stacking quotes endlessly. The
      // leading char of the once-escaped value is `'`, which is not
      // a formula trigger.
      const once = csvEscape('=A1');
      expect(csvEscape(once)).toBe(once);
    });

    it('leaves benign leading characters alone', () => {
      // Numeric, letters, slashes, parens, etc. don't trigger.
      expect(csvEscape('1234')).toBe('1234');
      expect(csvEscape('hello')).toBe('hello');
      expect(csvEscape('(parens)')).toBe('(parens)');
      expect(csvEscape('/path/to/thing')).toBe('/path/to/thing');
    });
  });
});
