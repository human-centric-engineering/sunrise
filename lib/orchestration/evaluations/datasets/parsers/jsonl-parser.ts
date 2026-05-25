/**
 * Dataset JSONL parser.
 *
 * One JSON object per line. Each object MUST have an `input` field;
 * optionally `expectedOutput`, `metadata`, `referenceCitations`.
 *
 * Strict by default: a malformed line throws (with the offending line
 * number) rather than silently skipping — for eval datasets, silent
 * data loss is the worst failure mode.
 *
 * Empty lines and comment lines beginning with `//` or `#` are skipped.
 */

import {
  type ParsedDataset,
  type ParsedDatasetCase,
  DatasetParseError,
} from '@/lib/orchestration/evaluations/datasets/parsers/types';

export function parseDatasetJsonl(content: string): ParsedDataset {
  // Strip UTF-8 BOM (U+FEFF) via escape sequence — keeps the source
  // file ASCII-clean for the eslint no-irregular-whitespace rule.
  const normalised = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalised.split('\n');
  const cases: ParsedDatasetCase[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNumber = i + 1;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) continue;

    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      throw new DatasetParseError(
        `Line ${lineNumber}: invalid JSON — ${err instanceof Error ? err.message : String(err)}`,
        lineNumber
      );
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new DatasetParseError(`Line ${lineNumber}: expected a JSON object`, lineNumber);
    }
    const record = obj as Record<string, unknown>;

    if (record.input === undefined || record.input === null) {
      throw new DatasetParseError(
        `Line ${lineNumber}: required field "input" is missing`,
        lineNumber
      );
    }
    let input: ParsedDatasetCase['input'];
    if (typeof record.input === 'string') {
      input = record.input;
    } else if (typeof record.input === 'object' && !Array.isArray(record.input)) {
      input = record.input as Record<string, unknown>;
    } else {
      throw new DatasetParseError(
        `Line ${lineNumber}: "input" must be a string or an object`,
        lineNumber
      );
    }

    const c: ParsedDatasetCase = { input };

    if (typeof record.expectedOutput === 'string') c.expectedOutput = record.expectedOutput;
    if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
      c.metadata = record.metadata as Record<string, unknown>;
    }
    if (Array.isArray(record.referenceCitations)) {
      c.referenceCitations = record.referenceCitations;
    }

    cases.push(c);
  }

  if (cases.length === 0) {
    throw new DatasetParseError('JSONL produced no usable cases');
  }
  return { cases, warnings };
}
