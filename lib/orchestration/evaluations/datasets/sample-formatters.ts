/**
 * Sample formatters — convert `datasetSamples` into CSV or JSONL text
 * that round-trips cleanly through the dataset parsers
 * (`csv-parser.ts` / `jsonl-parser.ts`).
 *
 * Kept here (not co-located with the React component) so the parser
 * round-trip test can import the formatters without pulling in React
 * or the shadcn Button. The client component re-exports these.
 *
 * CSV quoting follows RFC 4180. JSONL folds the literal-string `tags`
 * field into `metadata.tags` as an array because the JSONL parser has
 * no top-level `tags` field — the CSV parser does the same fold at
 * line 186 of csv-parser.ts.
 */

import type { DatasetSampleCase } from '@/components/admin/orchestration/evaluations-foundations/help-text';

const CSV_COLUMNS = ['input', 'expectedOutput', 'metadata', 'tags', 'referenceCitations'] as const;

function quoteCsvCell(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function caseToCsvRow(c: DatasetSampleCase): string {
  const cells: string[] = [];
  for (const col of CSV_COLUMNS) {
    let cell = '';
    if (col === 'input') cell = c.input;
    else if (col === 'expectedOutput') cell = c.expectedOutput ?? '';
    else if (col === 'metadata') cell = c.metadata ? JSON.stringify(c.metadata) : '';
    else if (col === 'tags') cell = c.tags ?? '';
    else if (col === 'referenceCitations') {
      cell = c.referenceCitations ? JSON.stringify(c.referenceCitations) : '';
    }
    cells.push(quoteCsvCell(cell));
  }
  return cells.join(',');
}

export function samplesToCsv(samples: readonly DatasetSampleCase[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = samples.map(caseToCsvRow);
  return [header, ...rows].join('\n') + '\n';
}

export function samplesToJsonl(samples: readonly DatasetSampleCase[]): string {
  return (
    samples
      .map((c) => {
        const metadata: Record<string, unknown> = { ...(c.metadata ?? {}) };
        if (c.tags) {
          metadata.tags = c.tags
            .split(',')
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
        }
        const out: Record<string, unknown> = { input: c.input };
        if (c.expectedOutput !== undefined) out.expectedOutput = c.expectedOutput;
        if (Object.keys(metadata).length > 0) out.metadata = metadata;
        if (c.referenceCitations) out.referenceCitations = c.referenceCitations;
        return JSON.stringify(out);
      })
      .join('\n') + '\n'
  );
}
