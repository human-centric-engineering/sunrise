'use client';

import { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle, FileText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { API } from '@/lib/api/endpoints';

import type { PdfPreviewData } from './document-upload-zone';

interface PdfPreviewModalProps {
  data: PdfPreviewData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
}

export function PdfPreviewModal({ data, open, onOpenChange, onConfirmed }: PdfPreviewModalProps) {
  const [correctedContent, setCorrectedContent] = useState('');
  const [category, setCategory] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    if (!data) return;
    setConfirming(true);
    setError(null);

    try {
      const body: Record<string, string> = { documentId: data.document.id };
      if (correctedContent.trim()) body.correctedContent = correctedContent.trim();
      if (category.trim()) body.category = category.trim();

      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentConfirm(data.document.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const resBody = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(resBody?.error?.message ?? `Confirmation failed (${res.status})`);
      }

      setCorrectedContent('');
      setCategory('');
      onOpenChange(false);
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setConfirming(false);
    }
  }, [data, correctedContent, category, onOpenChange, onConfirmed]);

  const handleDiscard = useCallback(async () => {
    if (!data) return;

    try {
      await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(data.document.id), {
        method: 'DELETE',
      });
    } catch {
      // Best-effort cleanup
    }

    setCorrectedContent('');
    setCategory('');
    onOpenChange(false);
  }, [data, onOpenChange]);

  if (!data) return null;

  const { preview } = data;
  const hasWarnings = preview.warnings.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Review PDF Extraction
          </DialogTitle>
          <DialogDescription>
            The text below was automatically extracted from{' '}
            <strong>{data.document.fileName}</strong>. Review it for accuracy — you can edit the
            text before confirming.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Metadata */}
          <div className="flex flex-wrap gap-3 text-sm">
            {preview.title && (
              <span>
                <span className="text-muted-foreground">Title:</span> {preview.title}
              </span>
            )}
            {preview.author && (
              <span>
                <span className="text-muted-foreground">Author:</span> {preview.author}
              </span>
            )}
            <span>
              <span className="text-muted-foreground">Sections:</span> {preview.sectionCount}
            </span>
          </div>

          {/* Warnings */}
          {hasWarnings && (
            <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
              <div className="flex items-center gap-1.5 text-sm font-medium text-amber-800 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4" />
                Extraction warnings
              </div>
              <ul className="space-y-0.5 pl-5 text-xs text-amber-700 dark:text-amber-300">
                {preview.warnings.map((w, i) => (
                  <li key={i} className="list-disc">
                    {w}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Extracted text */}
          <div className="space-y-1">
            <label htmlFor="pdf-content" className="text-sm font-medium">
              Extracted text
              <span className="text-muted-foreground ml-1 text-xs font-normal">
                (edit to correct OCR errors)
              </span>
            </label>
            <Textarea
              id="pdf-content"
              className="max-h-[300px] min-h-[200px] font-mono text-xs"
              defaultValue={preview.extractedText}
              onChange={(e) => setCorrectedContent(e.target.value)}
              placeholder="Extracted text appears here..."
            />
            <p className="text-muted-foreground text-xs">
              {preview.extractedText.length.toLocaleString()} characters extracted
            </p>
          </div>

          {/* Category */}
          <div className="space-y-1">
            <label htmlFor="pdf-category" className="text-sm font-medium">
              Category <span className="text-muted-foreground text-xs font-normal">(optional)</span>
            </label>
            <Input
              id="pdf-category"
              placeholder="e.g. sales, engineering, onboarding"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-8 text-sm"
            />
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => void handleDiscard()} disabled={confirming}>
            Discard
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={confirming}>
            <CheckCircle className="mr-1.5 h-4 w-4" />
            {confirming ? 'Confirming...' : 'Confirm & Chunk'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
