'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CheckCircle, CheckCircle2, FileText, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldHelp } from '@/components/ui/field-help';
import { Textarea } from '@/components/ui/textarea';
import { Tip } from '@/components/ui/tooltip';
import { API } from '@/lib/api/endpoints';

import type { PdfPreviewData } from '@/components/admin/orchestration/knowledge/document-upload-zone';

interface PdfPreviewModalProps {
  data: PdfPreviewData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirmed: () => void;
  /** Called after the document is discarded, so the caller can drop its row. */
  onDiscarded?: () => void;
}

export function PdfPreviewModal({
  data,
  open,
  onOpenChange,
  onConfirmed,
  onDiscarded,
}: PdfPreviewModalProps) {
  const router = useRouter();
  const [correctedContent, setCorrectedContent] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);

  // Reset state when a different document is opened
  useEffect(() => {
    setCorrectedContent(data?.preview.extractedText ?? '');
    setError(null);
    setDiscardError(null);
  }, [data?.document.id, data?.preview.extractedText]);

  const handleConfirm = useCallback(async () => {
    if (!data) return;
    setConfirming(true);
    setError(null);

    try {
      const body: Record<string, string> = { documentId: data.document.id };
      if (correctedContent.trim()) body.correctedContent = correctedContent.trim();

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

      const okBody = (await res.json().catch(() => null)) as {
        data?: { redirectTo?: string };
      } | null;

      setCorrectedContent('');
      onOpenChange(false);
      // When the upload was flagged runCleanup, the server returns a
      // redirectTo URL pointing at the cleanup chat page instead of
      // chunking. Navigate there; the list-refresh callback isn't useful
      // because the doc is now in 'cleaning', not 'ready'.
      if (okBody?.data?.redirectTo) {
        router.push(okBody.data.redirectTo);
        return;
      }
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed');
    } finally {
      setConfirming(false);
    }
  }, [data, correctedContent, onOpenChange, onConfirmed, router]);

  const handleDiscard = useCallback(async () => {
    if (!data) return;
    setDiscarding(true);
    setDiscardError(null);

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(data.document.id), {
        method: 'DELETE',
      });
      if (!res.ok) {
        setDiscardError(`Failed to discard document (${res.status})`);
        return;
      }
      setCorrectedContent('');
      onOpenChange(false);
      onDiscarded?.();
    } catch {
      setDiscardError('Network error — could not reach the server.');
    } finally {
      setDiscarding(false);
    }
  }, [data, onOpenChange, onDiscarded]);

  if (!data) return null;

  const { preview } = data;
  const hasWarnings = preview.warnings.length > 0;
  // Upload was flagged "Clean up before chunking". The extraction review
  // still happens first, so say so here — otherwise this dialog looks
  // identical to the plain PDF flow and the checkbox appears ignored.
  const wantsCleanup = data.runCleanup;

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
          {/* Cleanup pending notice */}
          {wantsCleanup && (
            <div className="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-200">
              <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <p>
                <span className="font-medium">Clean up before chunking is on.</span> Confirming
                opens the Document Clean Up chat with this text — nothing is chunked or embedded
                until you finish there.
              </p>
            </div>
          )}
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

          {/* Per-page extraction strip — one block per page, height
              proportional to char count, colored amber when the page came
              back below the scanned-suspect threshold. Lets the operator
              spot-check coverage without scrolling the full extracted text. */}
          {preview.pages && preview.pages.length > 0 && <PagesStrip pages={preview.pages} />}

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
              value={correctedContent}
              onChange={(e) => setCorrectedContent(e.target.value)}
              placeholder="Extracted text appears here..."
            />
            <p className="text-muted-foreground text-xs">
              {preview.extractedText.length.toLocaleString()} characters extracted
            </p>
          </div>

          {/* Tags are applied at upload time on the upload zone, not here.
              The preview flow only confirms the extracted text and chunks it. */}

          {error && <p className="text-destructive text-sm">{error}</p>}
          {discardError && <p className="text-destructive text-sm">{discardError}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="ghost"
            onClick={() => void handleDiscard()}
            disabled={confirming || discarding}
          >
            {discarding ? 'Discarding...' : 'Discard'}
          </Button>
          <Button onClick={() => void handleConfirm()} disabled={confirming}>
            {wantsCleanup ? (
              <Sparkles className="mr-1.5 h-4 w-4" />
            ) : (
              <CheckCircle className="mr-1.5 h-4 w-4" />
            )}
            {confirming ? 'Confirming...' : wantsCleanup ? 'Confirm & Clean Up' : 'Confirm & Chunk'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PageStat {
  num: number;
  charCount: number;
  hasText: boolean;
}

function PagesStrip({ pages }: { pages: PageStat[] }) {
  const max = Math.max(1, ...pages.map((p) => p.charCount));
  const total = pages.length;
  const withText = pages.filter((p) => p.hasText).length;
  const empty = total - withText;
  const totalChars = pages.reduce((acc, p) => acc + p.charCount, 0);
  // Pre-chunking page coverage: what fraction of pages produced enough
  // text to clear the scanned-suspect threshold. Mirrors the post-chunking
  // metric shown in the Chunks Inspector so the operator gets the same
  // green/amber headline at both stages of the pipeline.
  const pagePct = total === 0 ? 100 : Math.round((withText / total) * 1000) / 10;
  const healthy = pagePct >= 95;
  return (
    <div className="space-y-2">
      <div
        className={`flex items-start gap-2 rounded-md border p-3 text-xs ${
          healthy
            ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/30 dark:text-green-200'
            : 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200'
        }`}
      >
        {healthy ? (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <div className="flex-1">
          <span className="font-medium">{pagePct}% of pages produced text</span>{' '}
          <span className="opacity-80">
            ({withText} of {total} {total === 1 ? 'page' : 'pages'}, {totalChars.toLocaleString()}{' '}
            chars total
            {empty > 0 ? `, ${empty} likely scanned` : ''})
          </span>
          <FieldHelp title="Page coverage" ariaLabel="About page coverage" contentClassName="w-80">
            <p>
              Pre-chunking signal: what fraction of pages produced enough extractable text to clear
              the scanned-suspect threshold. The matching post-chunking metric — what fraction of
              the <em>parsed text</em> made it into stored chunks — appears in the Chunks Inspector
              after you confirm.
            </p>
            <p className="mt-2">
              <strong>Below 95%</strong> means a meaningful share of the PDF is likely image-only
              and an agent won&apos;t be able to retrieve that content. OCR those pages externally
              (macOS Preview, Adobe Acrobat, or <code>ocrmypdf</code>) and re-upload, or paste the
              corrected text into the editor below before confirming.
            </p>
          </FieldHelp>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          Per-page extraction
          <FieldHelp
            title="Per-page extraction"
            ariaLabel="About per-page extraction"
            contentClassName="w-80"
          >
            <p>
              One bar per page, height proportional to the character count extracted from that page.
              Hover any bar for the exact count.
            </p>
            <p className="mt-2">
              <strong>Amber bars</strong> mark pages whose extracted text fell below the
              scanned-suspect threshold — these are the pages counted against the page coverage
              figure above.
            </p>
          </FieldHelp>
        </div>
        <div className="bg-muted/30 flex h-12 items-end gap-px rounded-md border p-1">
          {pages.map((p) => {
            const heightPct = Math.max(4, Math.round((p.charCount / max) * 100));
            return (
              <Tip
                key={p.num}
                label={`Page ${p.num} — ${p.charCount.toLocaleString()} chars${p.hasText ? '' : ' (likely scanned)'}`}
              >
                <div
                  className={`min-w-[2px] flex-1 rounded-sm ${
                    p.hasText
                      ? 'bg-primary/60 hover:bg-primary'
                      : 'bg-amber-400 hover:bg-amber-500 dark:bg-amber-600 dark:hover:bg-amber-500'
                  }`}
                  style={{ height: `${heightPct}%` }}
                />
              </Tip>
            );
          })}
        </div>
      </div>
    </div>
  );
}
