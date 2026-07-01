'use client';

/**
 * DatasetUploadForm — upload a CSV or JSONL dataset.
 *
 * Single-page form. Uses the multipart POST path on
 * /api/v1/admin/orchestration/evaluations/datasets. FieldHelp on every
 * non-trivial field; tone matches the project standard (plain English,
 * concrete actions, examples in inline code).
 *
 * Validation is light at the form layer — the server-side handler does
 * the structured validation (Zod + parser) and returns specific errors.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FieldHelp } from '@/components/ui/field-help';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { datasetHelp } from '@/components/admin/orchestration/evaluations-foundations/help-text';
import { SampleDownloadButtons } from '@/components/admin/orchestration/evaluations-foundations/sample-download-buttons';
import { API } from '@/lib/api/endpoints';

const ACCEPTED_EXTENSIONS = ['.csv', '.jsonl', '.ndjson'];
const MAX_FILE_MB = 10;

interface UploadResult {
  datasetId: string;
  caseCount: number;
  contentHash: string;
  warnings: string[];
}

export function DatasetUploadForm(): React.ReactElement {
  const router = useRouter();
  const [file, setFile] = React.useState<File | null>(null);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [tags, setTags] = React.useState('');
  const [isUploading, setIsUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>): void {
    const selected = e.target.files?.[0];
    if (!selected) {
      setFile(null);
      return;
    }
    const ext = `.${selected.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      setError(`Unsupported file type. Use one of ${ACCEPTED_EXTENSIONS.join(', ')}.`);
      return;
    }
    if (selected.size > MAX_FILE_MB * 1024 * 1024) {
      setError(`File exceeds ${MAX_FILE_MB} MB cap.`);
      return;
    }
    setError(null);
    setFile(selected);
    if (!name) {
      // Seed the name from the filename stem if the user hasn't typed one.
      const stem = selected.name.replace(/\.[^.]+$/, '');
      setName(stem);
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Pick a CSV or JSONL file to upload.');
      return;
    }
    if (!name.trim()) {
      setError('Give the dataset a name.');
      return;
    }
    setIsUploading(true);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name.trim());
    if (description.trim()) formData.append('description', description.trim());
    if (tags.trim()) formData.append('tags', tags.trim());

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.EVAL_DATASETS, {
        method: 'POST',
        body: formData,
      });
      const payload = (await res.json()) as
        { success: true; data: UploadResult } | { success: false; error: { message: string } };
      if (!res.ok || !payload.success) {
        const msg = !payload.success ? payload.error.message : `Upload failed (${res.status})`;
        setError(msg);
        return;
      }
      router.push(`/admin/orchestration/evaluations/datasets/${payload.data.datasetId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-6">
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-base">Need a starting point?</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-sm">{datasetHelp.starterDownload}</p>
          <SampleDownloadButtons />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Upload file</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file">
              CSV or JSONL{' '}
              <FieldHelp title="Supported formats">{datasetHelp.uploadFormat}</FieldHelp>
            </Label>
            <Input
              id="file"
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(',')}
              onChange={handleFileSelect}
            />
            {file ? (
              <p className="text-muted-foreground text-xs">
                Selected: <span className="font-mono">{file.name}</span> (
                {(file.size / 1024).toFixed(1)} KB)
              </p>
            ) : null}
          </div>

          <div className="bg-muted/40 space-y-2 rounded-md p-3 text-xs">
            <p>
              <strong>Required:</strong> <code className="bg-background rounded px-1">input</code> —
              the prompt or workflow input.
            </p>
            <p>
              <strong>Optional:</strong>{' '}
              <code className="bg-background rounded px-1">expectedOutput</code>,{' '}
              <code className="bg-background rounded px-1">tags</code> (comma-separated),{' '}
              <code className="bg-background rounded px-1">metadata</code> (JSON cell or field),{' '}
              <code className="bg-background rounded px-1">referenceCitations</code> (JSON array),{' '}
              <code className="bg-background rounded px-1">difficulty</code>.
            </p>
            <p className="text-muted-foreground">
              CSV needs a header row. JSONL is one JSON object per line; empty lines and lines
              starting with <code>#</code> or <code>{'//'}</code> are skipped. See the worked
              example to the right.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">
              Name <FieldHelp title="Name">{datasetHelp.name}</FieldHelp>
            </Label>
            <Input
              id="name"
              placeholder="e.g. Customer-support FAQ — v1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">
              Description <FieldHelp title="Description">{datasetHelp.description}</FieldHelp>
            </Label>
            <Textarea
              id="description"
              rows={3}
              placeholder="Optional notes about what's covered here"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={2000}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="tags">
              Tags <FieldHelp title="Tags">{datasetHelp.tags}</FieldHelp>
            </Label>
            <Input
              id="tags"
              placeholder="refund-flow, edge-case, tier-1"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={isUploading}>
          Cancel
        </Button>
        <Button type="submit" disabled={isUploading || !file}>
          <Upload className="mr-1.5 h-4 w-4" aria-hidden />
          {isUploading ? 'Uploading…' : 'Upload dataset'}
        </Button>
      </div>
    </form>
  );
}
