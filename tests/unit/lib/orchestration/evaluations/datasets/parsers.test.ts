/**
 * Unit tests for dataset parsers (CSV + JSONL) and content hashing.
 *
 * Parsers are pure functions; no mocks required. Tests cover happy
 * paths, edge cases (BOM, CRLF, empty rows, quoted commas, JSON in
 * cells), and structurally bad input (missing input column, malformed
 * JSON line).
 */

import { describe, it, expect } from 'vitest';
import { parseDatasetCsv } from '@/lib/orchestration/evaluations/datasets/parsers/csv-parser';
import { parseDatasetJsonl } from '@/lib/orchestration/evaluations/datasets/parsers/jsonl-parser';
import { DatasetParseError } from '@/lib/orchestration/evaluations/datasets/parsers/types';
import { hashDatasetCases, hashParsedCases } from '@/lib/orchestration/evaluations/datasets/hash';

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

describe('parseDatasetCsv', () => {
  it('parses a minimal header + row', () => {
    const out = parseDatasetCsv('input\nHello world\n');
    expect(out.cases).toEqual([{ input: 'Hello world' }]);
  });

  it('handles BOM and CRLF line endings', () => {
    const csv = '﻿input,expectedOutput\r\nHi,Hello\r\n';
    const out = parseDatasetCsv(csv);
    expect(out.cases).toEqual([{ input: 'Hi', expectedOutput: 'Hello' }]);
  });

  it('honours quoted cells with embedded commas', () => {
    const csv = 'input,expectedOutput\n"What is 1, 2, 3?","Numbers."';
    const out = parseDatasetCsv(csv);
    expect(out.cases[0].input).toBe('What is 1, 2, 3?');
    expect(out.cases[0].expectedOutput).toBe('Numbers.');
  });

  it('throws when the input column is missing', () => {
    expect(() => parseDatasetCsv('question,answer\nA,B')).toThrow(DatasetParseError);
  });

  it('throws when the input cell is empty', () => {
    expect(() => parseDatasetCsv('input,expectedOutput\n,B')).toThrow(/empty/i);
  });

  it('folds tags column into metadata', () => {
    const csv = 'input,tags\nQ,"refund,edge-case"';
    const out = parseDatasetCsv(csv);
    expect(out.cases[0].metadata).toEqual({ tags: ['refund', 'edge-case'] });
  });

  it('parses JSON object input into a workflow-style input object', () => {
    const csv = 'input\n"{""sku"": ""ABC""}"';
    const out = parseDatasetCsv(csv);
    expect(out.cases[0].input).toEqual({ sku: 'ABC' });
  });

  it('skips fully-empty rows with a warning', () => {
    const csv = 'input\nA\n\nB';
    const out = parseDatasetCsv(csv);
    expect(out.cases).toHaveLength(2);
    expect(out.warnings.some((w) => /empty row/.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JSONL
// ---------------------------------------------------------------------------

describe('parseDatasetJsonl', () => {
  it('parses one object per line', () => {
    const jsonl = '{"input":"A","expectedOutput":"a"}\n{"input":"B"}\n';
    const out = parseDatasetJsonl(jsonl);
    expect(out.cases).toEqual([{ input: 'A', expectedOutput: 'a' }, { input: 'B' }]);
  });

  it('accepts object-shaped input', () => {
    const jsonl = '{"input":{"sku":"ABC"},"expectedOutput":"ok"}';
    const out = parseDatasetJsonl(jsonl);
    expect(out.cases[0].input).toEqual({ sku: 'ABC' });
  });

  it('skips empty lines and # / // comments', () => {
    const jsonl = '# header comment\n{"input":"A"}\n\n// trailing\n{"input":"B"}\n';
    const out = parseDatasetJsonl(jsonl);
    expect(out.cases.map((c) => c.input)).toEqual(['A', 'B']);
  });

  it('throws (loudly) on a malformed line with the line number', () => {
    expect(() => parseDatasetJsonl('{"input":"A"}\n{bad json\n')).toThrow(/Line 2/);
  });

  it('throws when input is missing', () => {
    expect(() => parseDatasetJsonl('{"x":1}')).toThrow(/required field "input"/);
  });

  it('throws when input is neither string nor object', () => {
    expect(() => parseDatasetJsonl('{"input":[1,2,3]}')).toThrow(/string or an object/);
  });
});

// ---------------------------------------------------------------------------
// hash
// ---------------------------------------------------------------------------

describe('hashDatasetCases', () => {
  it('produces the same hash for the same content', () => {
    const a = [{ position: 0, input: 'Q1' }];
    const b = [{ position: 0, input: 'Q1' }];
    expect(hashDatasetCases(a)).toBe(hashDatasetCases(b));
  });

  it('is sensitive to position (reordering changes the hash)', () => {
    const a = [
      { position: 0, input: 'A' },
      { position: 1, input: 'B' },
    ];
    const b = [
      { position: 0, input: 'B' },
      { position: 1, input: 'A' },
    ];
    expect(hashDatasetCases(a)).not.toBe(hashDatasetCases(b));
  });

  it('treats key order in metadata as canonical (sorted)', () => {
    const a = [{ position: 0, input: 'Q', metadata: { z: 1, a: 2 } }];
    const b = [{ position: 0, input: 'Q', metadata: { a: 2, z: 1 } }];
    expect(hashDatasetCases(a)).toBe(hashDatasetCases(b));
  });

  it('hashParsedCases assigns positions in array order', () => {
    const cases = [{ input: 'A' }, { input: 'B' }];
    const explicit = hashDatasetCases([
      { position: 0, input: 'A' },
      { position: 1, input: 'B' },
    ]);
    expect(hashParsedCases(cases)).toBe(explicit);
  });
});
