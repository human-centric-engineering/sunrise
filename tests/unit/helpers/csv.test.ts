/**
 * Unit Tests: parseCsvRecords (test helper)
 *
 * The #768 regression tests depend on this splitter reading CSV the way a
 * spreadsheet does; if it drifts, those tests can pass on a broken export.
 *
 * @see tests/helpers/csv.ts
 */

import { describe, it, expect } from 'vitest';

import { parseCsvRecords } from '@/tests/helpers/csv';

describe('parseCsvRecords', () => {
  it('ends a record on CRLF, a lone LF and a lone CR', () => {
    expect(parseCsvRecords('a,b\r\nc,d\ne,f\rg,h')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
  });

  it('keeps CR, LF and doubled quotes inside a quoted cell as data', () => {
    expect(parseCsvRecords('"x\ry\nz","a""b"')).toEqual([['x\ry\nz', 'a"b']]);
  });

  it('reads a quote after the start of an unquoted cell as a literal', () => {
    // A spreadsheet does not open a quoted section mid-field, so the CR
    // still ends the record.
    expect(parseCsvRecords('ab"c\r=x')).toEqual([['ab"c'], ['=x']]);
  });

  it('keeps a final record that holds one empty quoted cell', () => {
    expect(parseCsvRecords('h\n""')).toEqual([['h'], ['']]);
  });

  it('does not add a record for a trailing newline', () => {
    expect(parseCsvRecords('a,b\n')).toEqual([['a', 'b']]);
  });

  it('throws on an unclosed quoted cell', () => {
    expect(() => parseCsvRecords('a,"b\nc,d')).toThrow('unclosed quoted cell');
  });
});
