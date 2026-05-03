/**
 * CSV document parser.
 *
 * Pure-TS RFC 4180 implementation with delimiter sniffing and header
 * detection. Each data row becomes its own section so downstream chunking
 * can keep rows atomic (one chunk per row), preserving row-level retrieval
 * for queries like "show me the payment to Acme on 2025-03-14".
 *
 * No third-party dependencies.
 */

import type { ParsedDocument, ParsedSection } from '@/lib/orchestration/knowledge/parsers/types';

/** Number of leading non-empty lines used for delimiter sniffing. */
const SNIFF_SAMPLE_LINES = 5;

/** Candidates considered for delimiter sniffing, in tie-break order. */
const DELIMITER_CANDIDATES = [',', '\t', ';'] as const;
type Delimiter = (typeof DELIMITER_CANDIDATES)[number];

/** Cells beyond this width trigger a warning (likely malformed CSV). */
const VERY_WIDE_ROW_THRESHOLD = 100;

interface ParseResult {
  rows: string[][];
  warnings: string[];
}

/**
 * Tokenize CSV content into rows of cells, honoring RFC 4180 quoting.
 * Handles escaped quotes (`""`), embedded newlines inside quoted cells,
 * and unbalanced-quote recovery (warns and treats remainder as a single cell).
 */
function tokenize(content: string, delimiter: Delimiter): ParseResult {
  const rows: string[][] = [];
  const warnings: string[] = [];

  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let rowStartLine = 1;
  let currentLine = 1;

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
        if (ch === '\n') currentLine++;
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      continue;
    }

    if (ch === '\r') {
      // Swallow; \n on the next iteration finalises the row.
      continue;
    }

    if (ch === '\n') {
      row.push(cell);
      cell = '';
      if (row.length > 1 || row[0].length > 0) rows.push(row);
      row = [];
      currentLine++;
      rowStartLine = currentLine;
      continue;
    }

    cell += ch;
  }

  if (inQuotes) {
    warnings.push(`Row ${rowStartLine}: unbalanced quote — remaining content treated as one cell`);
  }

  // Flush final row if no trailing newline.
  row.push(cell);
  if (row.length > 1 || row[0].length > 0) rows.push(row);

  return { rows, warnings };
}

/**
 * Sniff the most likely delimiter from the first few non-empty lines.
 * Counts occurrences outside quoted regions; ties resolve in favour of `,`.
 */
function sniffDelimiter(content: string): Delimiter {
  const lines: string[] = [];
  let inQuotes = false;
  let buf = '';
  for (let i = 0; i < content.length && lines.length < SNIFF_SAMPLE_LINES; i++) {
    const ch = content[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      buf += ch;
      continue;
    }
    if (ch === '\n' && !inQuotes) {
      if (buf.trim().length > 0) lines.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0 && lines.length < SNIFF_SAMPLE_LINES) lines.push(buf);

  const counts: Record<Delimiter, number> = { ',': 0, '\t': 0, ';': 0 };
  for (const line of lines) {
    let lineQuoted = false;
    for (const ch of line) {
      if (ch === '"') {
        lineQuoted = !lineQuoted;
        continue;
      }
      if (lineQuoted) continue;
      if (ch === ',' || ch === '\t' || ch === ';') counts[ch]++;
    }
  }

  let best: Delimiter = ',';
  let bestCount = counts[','];
  for (const candidate of DELIMITER_CANDIDATES) {
    if (counts[candidate] > bestCount) {
      best = candidate;
      bestCount = counts[candidate];
    }
  }
  return best;
}

/**
 * Decide whether the first row looks like a header.
 *
 * Heuristic: header iff (a) every cell is non-empty, (b) no cell is purely
 * numeric, and (c) fewer than half the cells duplicate a value in row 2.
 * Returns false if there is no row 2 to compare against.
 */
function detectHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  const second = rows[1];

  if (first.some((c) => c.trim().length === 0)) return false;
  if (first.some((c) => /^-?\d+(\.\d+)?$/.test(c.trim()))) return false;

  let duplicates = 0;
  for (let i = 0; i < first.length; i++) {
    if (second[i] !== undefined && first[i].trim() === second[i].trim()) duplicates++;
  }
  return duplicates < first.length / 2;
}

export function parseCsv(buffer: Buffer, fileName: string): ParsedDocument {
  const warnings: string[] = [];
  const content = buffer.toString('utf-8');

  if (content.trim().length === 0) {
    return {
      title: fileName.replace(/\.[^.]+$/, ''),
      sections: [],
      fullText: '',
      metadata: { format: 'csv' },
      warnings: ['CSV is empty'],
    };
  }

  const delimiter = sniffDelimiter(content);
  const { rows, warnings: parseWarnings } = tokenize(content, delimiter);
  warnings.push(...parseWarnings);

  if (rows.length === 0) {
    return {
      title: fileName.replace(/\.[^.]+$/, ''),
      sections: [],
      fullText: '',
      metadata: { format: 'csv', delimiter, rowCount: '0', columnCount: '0', hasHeader: 'false' },
      warnings: [...warnings, 'CSV produced no rows'],
    };
  }

  const hasHeader = detectHeader(rows);
  const headers = hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`);
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const columnCount = headers.length;

  warnings.push(`Detected header row: ${hasHeader ? 'yes' : 'no'}`);
  if (columnCount > VERY_WIDE_ROW_THRESHOLD) {
    warnings.push(`Wide CSV detected: ${columnCount} columns — retrieval may suffer`);
  }

  const sections: ParsedSection[] = dataRows.map((row, idx) => {
    const pairs = headers.map((header, i) => `${header}: ${row[i] ?? ''}`).join(' | ');
    return {
      title: `Row ${idx + 1}`,
      content: pairs,
      order: idx,
    };
  });

  const fullText = sections.map((s) => s.content).join('\n');

  return {
    title: fileName.replace(/\.[^.]+$/, ''),
    sections,
    fullText,
    metadata: {
      format: 'csv',
      delimiter,
      rowCount: String(dataRows.length),
      columnCount: String(columnCount),
      hasHeader: String(hasHeader),
    },
    warnings,
  };
}
