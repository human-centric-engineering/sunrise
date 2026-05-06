'use client';

/**
 * PublishDialog
 *
 * Confirmation dialog for promoting the in-progress `draftDefinition` to a
 * new immutable `AiWorkflowVersion`. Optional `changeSummary` (max 500 chars)
 * is persisted on the new version row so future admins can read why the
 * publish happened.
 *
 * The dialog itself does NOT call the API — `onConfirm` is the parent's
 * publish handler. Keeps this component testable as a pure controlled UI.
 */

import * as React from 'react';

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
import { Textarea } from '@/components/ui/textarea';

const MAX_CHANGE_SUMMARY_CHARS = 500;

export interface PublishDialogProps {
  /** Controls dialog open state. */
  open: boolean;
  /** Called when the dialog is dismissed without publishing. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the trimmed `changeSummary` (or undefined if the field is
   * empty) when the user confirms. The parent is responsible for the actual
   * POST and any error handling.
   */
  onConfirm: (changeSummary: string | undefined) => void | Promise<void>;
  /** True while the publish request is in flight — disables the Publish button. */
  publishing?: boolean;
  /** Optional inline error rendered above the footer. */
  errorMessage?: string | null;
  /** The version int that will be assigned on confirm. Display-only. */
  nextVersion?: number;
}

export function PublishDialog({
  open,
  onOpenChange,
  onConfirm,
  publishing = false,
  errorMessage = null,
  nextVersion,
}: PublishDialogProps): React.ReactElement {
  const [summary, setSummary] = React.useState('');

  // Reset the input each time the dialog re-opens so a previous draft summary
  // doesn't bleed into the next publish.
  React.useEffect(() => {
    if (open) setSummary('');
  }, [open]);

  const trimmed = summary.trim();
  const tooLong = trimmed.length > MAX_CHANGE_SUMMARY_CHARS;
  const charsLeft = MAX_CHANGE_SUMMARY_CHARS - trimmed.length;

  const handleConfirm = React.useCallback(() => {
    if (tooLong || publishing) return;
    void onConfirm(trimmed.length > 0 ? trimmed : undefined);
  }, [tooLong, publishing, onConfirm, trimmed]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish draft</DialogTitle>
          <DialogDescription>
            Promotes the in-progress draft to{' '}
            {nextVersion ? `version ${nextVersion}` : 'a new version'}. New executions (manual,
            scheduled, or webhook-triggered) will pin to this snapshot. The currently published
            version is preserved in the history and can be rolled back to.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="publish-change-summary">Change summary (optional)</Label>
          <Textarea
            id="publish-change-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="What changed in this version?"
            rows={3}
            disabled={publishing}
            aria-describedby="publish-change-summary-help"
          />
          <p
            id="publish-change-summary-help"
            className={'text-xs ' + (tooLong ? 'text-destructive' : 'text-muted-foreground')}
          >
            {tooLong
              ? `${-charsLeft} characters over the ${MAX_CHANGE_SUMMARY_CHARS} limit`
              : `${charsLeft} characters left`}
          </p>
        </div>

        {errorMessage && (
          <p className="text-destructive text-sm" role="alert">
            {errorMessage}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={publishing}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={publishing || tooLong}>
            {publishing ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
