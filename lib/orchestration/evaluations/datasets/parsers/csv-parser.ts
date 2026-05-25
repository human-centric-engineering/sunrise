/**
 * Dataset CSV parser.
 *
 * Reads a CSV with a header row and returns one `ParsedDatasetCase`
 * per data row. Required header: `input`. Optional headers:
 * `expectedOutput`, `metadata` (JSON), `tags` (comma-separated, folded
 * into metadata.tags), `referenceCitations` (JSON), `difficulty`
 * (folded into metadata.difficulty).
 *
 * Designed to be friendly to spreadsheet exports — strips BOM,
 * normalises CRLF/CR line endings, handles quoted cells with embedded
 * commas and `""` escaping (RFC 4180).
 *
 * Distinct from `lib/orchestration/knowledge/parsers/csv-parser.ts`
 * which produces a `ParsedDocument` for chunked retrieval. That one
 * doesn't surface row objects — datasets need exactly that, so we
 * carry our own slim parser here. The tokenisation lessons (BOM,
 * CR-only line endings) match.
 */

import {
  type ParsedDataset,
  type ParsedDatasetCase,
  DatasetParseError,
} from '@/lib/orchestration/evaluations/datasets/parsers/types';

const DELIMITER_CANDIDATES = [',', '\t', ';'] as const;
type Delimiter = (typeof DELIMITER_CANDIDATES)[number];

interface TokenizeResult {
  rows: string[][];
  warnings: string[];
}

function sniffDelimiter(sample: string): Delimiter {
  // Strip quoted segments before counting so a header like
  // `input,expectedOutput` followed by `"a, b","c"` doesn't make the
  // sniffer flip to tab. Comma wins on tie because it's the de facto
  // CSV default and the format hint operators actually expect.
  const stripped = sample.replace(/"[^"]*"/g, '""');
  const lines = stripped
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .slice(0, 5);
  let best: Delimiter = ',';
  let bestColumns = 0;
  for (const delim of DELIMITER_CANDIDATES) {
    const counts = lines.map((l) => l.split(delim).length);
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    if (min === max && min > bestColumns) {
      best = delim;
      bestColumns = min;
    }
  }
  return best;
}

function tokenize(content: string, delimiter: Delimiter): TokenizeResult {
  const rows: string[][] = [];
  const warnings: string[] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (inQuotes) {
    warnings.push('Unterminated quoted cell at end of file — content may be truncated.');
  }
  return { rows, warnings };
}

function parseCellAsJson(value: string, columnName: string, lineNumber: number): unknown {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    throw new DatasetParseError(
      `Row ${lineNumber}: column "${columnName}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      lineNumber
    );
  }
}

export function parseDatasetCsv(content: string): ParsedDataset {
  const normalised = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (normalised.trim().length === 0) {
    throw new DatasetParseError('CSV is empty');
  }

  const delimiter = sniffDelimiter(normalised);
  const { rows, warnings } = tokenize(normalised, delimiter);
  if (rows.length < 2) {
    throw new DatasetParseError('CSV must contain a header row and at least one data row');
  }

  const headers = rows[0].map((h) => h.trim());
  if (!headers.includes('input')) {
    throw new DatasetParseError('Required column "input" is missing from the header row');
  }
  const inputIdx = headers.indexOf('input');
  const expectedOutputIdx = headers.indexOf('expectedOutput');
  const metadataIdx = headers.indexOf('metadata');
  const tagsIdx = headers.indexOf('tags');
  const referenceCitationsIdx = headers.indexOf('referenceCitations');
  const difficultyIdx = headers.indexOf('difficulty');

  const cases: ParsedDatasetCase[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const lineNumber = r + 1;
    if (row.every((c) => c.trim().length === 0)) {
      warnings.push(`Row ${lineNumber}: empty row skipped`);
      continue;
    }

    const inputRaw = row[inputIdx] ?? '';
    if (!inputRaw.trim()) {
      throw new DatasetParseError(
        `Row ${lineNumber}: required column "input" is empty`,
        lineNumber
      );
    }
    // `input` may be a plain string (agent prompt) or a JSON object
    // (workflow input vars). Try JSON first; fall back to literal.
    let input: ParsedDatasetCase['input'];
    const inputTrimmed = inputRaw.trim();
    if (inputTrimmed.startsWith('{') || inputTrimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(inputTrimmed);
        input =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : inputTrimmed;
      } catch {
        input = inputTrimmed;
      }
    } else {
      input = inputTrimmed;
    }

    const c: ParsedDatasetCase = { input };

    if (expectedOutputIdx !== -1 && row[expectedOutputIdx]?.trim()) {
      c.expectedOutput = row[expectedOutputIdx];
    }

    const metadata: Record<string, unknown> = {};
    if (metadataIdx !== -1) {
      const parsed = parseCellAsJson(row[metadataIdx] ?? '', 'metadata', lineNumber);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(metadata, parsed);
      }
    }
    if (tagsIdx !== -1 && row[tagsIdx]?.trim()) {
      metadata.tags = row[tagsIdx]
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
    }
    if (difficultyIdx !== -1 && row[difficultyIdx]?.trim()) {
      metadata.difficulty = row[difficultyIdx].trim();
    }
    if (Object.keys(metadata).length > 0) c.metadata = metadata;

    if (referenceCitationsIdx !== -1) {
      const parsed = parseCellAsJson(
        row[referenceCitationsIdx] ?? '',
        'referenceCitations',
        lineNumber
      );
      if (Array.isArray(parsed)) c.referenceCitations = parsed;
    }

    cases.push(c);
  }

  if (cases.length === 0) {
    throw new DatasetParseError('CSV had a header row but no usable data rows');
  }
  return { cases, warnings };
}
