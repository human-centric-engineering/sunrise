'use client';

/**
 * SaveToDatasetButton
 *
 * Compact button that opens a modal for capturing a real production
 * trace into an existing dataset case. Two source modes, picked by the
 * caller:
 *
 *   - `kind: 'conversation_turn'` — used from the conversation detail
 *     page. `messageId` points at an assistant message; the API pairs
 *     it with the immediately preceding user turn.
 *   - `kind: 'workflow_execution'` — used from the workflow execution
 *     detail page. Caller passes the `executionId` + a selector
 *     mirroring `AiEvaluationRun.subjectOutputSelector` (defaults to
 *     `'last_step'`).
 *
 * Both paths POST to the same capture endpoint
 * (`/datasets/:id/capture`). The modal loads the user's datasets and
 * lets them pick one before saving.
 */

import * as React from 'react';
import { Bookmark, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { API } from '@/lib/api/endpoints';

interface DatasetOption {
  id: string;
  name: string;
  caseCount: number;
}

type Source =
  | { kind: 'conversation_turn'; messageId: string }
  | {
      kind: 'workflow_execution';
      executionId: string;
      selector?: { kind: 'final_report' | 'last_step' | 'step_id'; stepId?: string };
    };

interface SaveToDatasetButtonProps {
  source: Source;
  /** Optional override label; defaults to a compact "Save to dataset". */
  label?: string;
  /** Render a smaller variant suitable for inline placement next to other inline actions. */
  size?: 'sm' | 'default';
}

interface CaptureResult {
  datasetId: string;
  appendedCount: number;
  newCaseCount: number;
}

type ApiSuccess<T> = { success: true; data: T };
type ApiError = { success: false; error: { message: string } };

export function SaveToDatasetButton({
  source,
  label = 'Save to dataset',
  size = 'sm',
}: SaveToDatasetButtonProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [datasets, setDatasets] = React.useState<DatasetOption[] | null>(null);
  const [datasetId, setDatasetId] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<CaptureResult | null>(null);

  // Lazy-load datasets when the modal opens. Cheap (single paginated
  // GET) and keeps the page render budget small.
  React.useEffect(() => {
    if (!open || datasets !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`${API.ADMIN.ORCHESTRATION.EVAL_DATASETS}?limit=100`);
        const payload = (await res.json()) as
          | ApiSuccess<DatasetOption[] | { items?: DatasetOption[]; data?: DatasetOption[] }>
          | ApiError;
        if (cancelled) return;
        if (!res.ok || !payload.success) {
          const msg = !payload.success ? payload.error.message : `Failed (${res.status})`;
          setError(msg);
          setDatasets([]);
          return;
        }
        // Tolerate either bare-array or `{ items: [...] }` envelopes.
        const list: DatasetOption[] = Array.isArray(payload.data)
          ? payload.data
          : ((payload.data as { items?: DatasetOption[] }).items ?? []);
        setDatasets(list);
        setDatasetId(list[0]?.id ?? '');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setDatasets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, datasets]);

  async function handleSave(): Promise<void> {
    if (!datasetId) {
      setError('Pick a destination dataset.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const body =
        source.kind === 'conversation_turn'
          ? { kind: 'conversation_turn', messageId: source.messageId }
          : {
              kind: 'workflow_execution',
              executionId: source.executionId,
              selector: source.selector ?? { kind: 'last_step' },
            };
      const res = await fetch(API.ADMIN.ORCHESTRATION.evalDatasetCapture(datasetId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as ApiSuccess<CaptureResult> | ApiError;
      if (!res.ok || !payload.success) {
        const msg = !payload.success ? payload.error.message : `Failed (${res.status})`;
        setError(msg);
        return;
      }
      setSuccess(payload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose(): void {
    setOpen(false);
    // Reset success/error on close so the modal opens fresh next time.
    // Keep `datasets` cached so we don't refetch on every open.
    setSuccess(null);
    setError(null);
  }

  return (
    <>
      <Button size={size} variant="outline" onClick={() => setOpen(true)}>
        <Bookmark className="mr-1.5 h-3.5 w-3.5" aria-hidden />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : handleClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save to dataset</DialogTitle>
            <DialogDescription>
              {source.kind === 'conversation_turn'
                ? 'Captures this assistant turn (paired with the preceding user message) as a new dataset case. Citations carry through as referenceCitations.'
                : 'Captures this workflow execution as a new dataset case. The selected step output becomes the expectedOutput.'}
            </DialogDescription>
          </DialogHeader>

          {success ? (
            <SuccessPanel result={success} onClose={handleClose} />
          ) : (
            <div className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="capture-dataset">Destination dataset</Label>
                {datasets === null ? (
                  <p className="text-muted-foreground inline-flex items-center gap-2 text-sm">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Loading datasets…
                  </p>
                ) : datasets.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    No datasets yet. Upload one first, then come back.
                  </p>
                ) : (
                  <Select value={datasetId} onValueChange={setDatasetId}>
                    <SelectTrigger id="capture-dataset">
                      <SelectValue placeholder="Pick a dataset" />
                    </SelectTrigger>
                    <SelectContent>
                      {datasets.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name} ({d.caseCount} cases)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {error ? (
                <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
                  {error}
                </div>
              ) : null}
            </div>
          )}

          {!success ? (
            <DialogFooter>
              <Button variant="ghost" onClick={handleClose} disabled={submitting}>
                Cancel
              </Button>
              <Button onClick={() => void handleSave()} disabled={submitting || !datasetId}>
                {submitting ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Save
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function SuccessPanel({
  result,
  onClose,
}: {
  result: CaptureResult;
  onClose: () => void;
}): React.ReactElement {
  return (
    <div className="space-y-4 py-2">
      <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900/40 dark:bg-emerald-950/30">
        <p className="font-medium text-emerald-900 dark:text-emerald-200">
          Captured · dataset now has {result.newCaseCount} case
          {result.newCaseCount === 1 ? '' : 's'}.
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          The dataset&apos;s content hash was recomputed so future runs see the new case.
        </p>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </div>
  );
}
