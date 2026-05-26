'use client';

/**
 * SampleDownloadButtons — emits a 3-case starter dataset as a CSV or
 * JSONL file the admin can edit and re-upload through the same form.
 *
 * The output round-trips through `lib/orchestration/evaluations/datasets/
 * parsers/{csv-parser,jsonl-parser}.ts`. Formatting lives in
 * `lib/orchestration/evaluations/datasets/sample-formatters.ts` so the
 * parser round-trip test can import it without React.
 */

import * as React from 'react';
import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { datasetSamples } from '@/components/admin/orchestration/evaluations-foundations/help-text';
import {
  samplesToCsv,
  samplesToJsonl,
} from '@/lib/orchestration/evaluations/datasets/sample-formatters';

function triggerDownload(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function SampleDownloadButtons(): React.ReactElement {
  function handleCsv(): void {
    triggerDownload(samplesToCsv(datasetSamples), 'sample-dataset.csv', 'text/csv');
  }
  function handleJsonl(): void {
    triggerDownload(samplesToJsonl(datasetSamples), 'sample-dataset.jsonl', 'application/x-ndjson');
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" onClick={handleCsv}>
        <Download className="mr-1.5 h-4 w-4" aria-hidden />
        Download CSV
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={handleJsonl}>
        <Download className="mr-1.5 h-4 w-4" aria-hidden />
        Download JSONL
      </Button>
    </div>
  );
}
