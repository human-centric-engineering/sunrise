/**
 * /admin/orchestration/evaluations/datasets/new
 *
 * Server page that renders the upload form (client component). Heavy
 * lifting lives in the form; this page is the shell + nav crumb.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DatasetUploadForm } from '@/components/admin/orchestration/evaluations-foundations/dataset-upload-form';

export const metadata: Metadata = {
  title: 'Upload dataset · AI Orchestration',
  description: 'Upload a CSV or JSONL dataset for batch evaluation runs.',
};

export default function NewDatasetPage(): React.ReactElement {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/admin/orchestration/evaluations/datasets">
            <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
            Datasets
          </Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Upload dataset</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Drop a CSV or JSONL file. The required column is{' '}
          <code className="bg-muted rounded px-1 text-xs">input</code>; everything else is optional.
        </p>
      </div>

      <DatasetUploadForm />
    </div>
  );
}
