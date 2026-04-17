'use client';

/**
 * WorkflowDetailsDialog — captures the fields the POST `/workflows`
 * endpoint needs that the toolbar name input alone doesn&rsquo;t supply:
 * `slug`, `description`, `errorStrategy`, `isTemplate`.
 *
 * Triggered by Save on the first create-mode save. In edit mode the
 * builder already has these values from the fetched `AiWorkflow`, so it
 * doesn&rsquo;t open the dialog.
 *
 * The slug auto-derives from the workflow name (lower-cased, hyphen-
 * separated) until the user touches the slug field, after which it stays
 * manual &mdash; matching the create behaviour in `capability-form.tsx`.
 */

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';

import type { WorkflowDetails } from './workflow-save';

/** Match the server-side `slugSchema` in `lib/validations/common.ts`. */
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Convert a free-form name to a URL-safe slug. */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface WorkflowDetailsDialogProps {
  open: boolean;
  /** Workflow name from the toolbar — seeds the slug auto-derivation. */
  workflowName: string;
  /** Current details (used when re-opening in edit mode). */
  initial?: Partial<WorkflowDetails>;
  onOpenChange: (open: boolean) => void;
  onConfirm: (details: WorkflowDetails) => void;
}

export function WorkflowDetailsDialog({
  open,
  workflowName,
  initial,
  onOpenChange,
  onConfirm,
}: WorkflowDetailsDialogProps) {
  // `slugOverride` is null until the user manually edits the slug field —
  // while null, the slug is derived from `workflowName` on every render,
  // which keeps auto-derivation without an effect + setState.
  const [slugOverride, setSlugOverride] = useState<string | null>(initial?.slug ?? null);
  const [description, setDescription] = useState<string>(initial?.description ?? '');
  const [errorStrategy, setErrorStrategy] = useState<WorkflowDetails['errorStrategy']>(
    initial?.errorStrategy ?? 'fail'
  );
  const [isTemplate, setIsTemplate] = useState<boolean>(initial?.isTemplate ?? false);

  const slug = slugOverride ?? slugify(workflowName);

  const slugValid = SLUG_REGEX.test(slug);
  const descriptionValid = description.trim().length > 0;
  const canConfirm = slugValid && descriptionValid;

  const handleConfirm = (): void => {
    if (!canConfirm) return;
    onConfirm({ slug, description: description.trim(), errorStrategy, isTemplate });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Workflow details</DialogTitle>
          <DialogDescription>
            A few extra fields the API needs before this workflow can be saved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="details-slug" className="flex items-center">
              Slug{' '}
              <FieldHelp title="Slug">
                URL-safe identifier. Lowercase letters, numbers, and hyphens only. Auto-derived from
                the workflow name until you edit it manually — e.g.{' '}
                <code>customer-triage-flow</code>.
              </FieldHelp>
            </Label>
            <Input
              id="details-slug"
              value={slug}
              onChange={(e) => setSlugOverride(e.target.value)}
              placeholder="my-workflow"
              aria-invalid={!slugValid}
            />
            {!slugValid && (
              <p className="text-xs text-red-600">
                Must be lowercase alphanumeric with hyphens only.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="details-description" className="flex items-center">
              Description{' '}
              <FieldHelp title="Description">
                A one- or two-sentence summary of what this workflow does. Shown on the workflows
                list page.
              </FieldHelp>
            </Label>
            <Textarea
              id="details-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Summarises call transcripts and drafts a follow-up email."
              rows={3}
              aria-invalid={!descriptionValid}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="details-error-strategy" className="flex items-center">
              Error strategy{' '}
              <FieldHelp title="Error strategy" contentClassName="w-80">
                What the engine does when a step fails:
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  <li>
                    <strong>Fail</strong> — stop immediately. Use when errors are unrecoverable.
                  </li>
                  <li>
                    <strong>Retry</strong> — try the failed step again. Use for transient issues
                    like network timeouts.
                  </li>
                  <li>
                    <strong>Fallback</strong> — run a backup path you&apos;ve connected in the
                    builder. Use when you have an alternative approach (e.g. try a different model).
                  </li>
                </ul>
              </FieldHelp>
            </Label>
            <Select
              value={errorStrategy}
              onValueChange={(value) => setErrorStrategy(value as WorkflowDetails['errorStrategy'])}
            >
              <SelectTrigger id="details-error-strategy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fail">Fail fast</SelectItem>
                <SelectItem value="retry">Retry step</SelectItem>
                <SelectItem value="skip">Skip step</SelectItem>
                <SelectItem value="fallback">Fallback branch</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="details-is-template"
              checked={isTemplate}
              onCheckedChange={(checked) => setIsTemplate(checked === true)}
            />
            <Label htmlFor="details-is-template" className="flex items-center font-normal">
              Save as template{' '}
              <FieldHelp title="Template">
                Templates show up in the &ldquo;Use Template&rdquo; dropdown when starting a new
                workflow. Usually off for one-off workflows, on for reusable patterns.
              </FieldHelp>
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            Save workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
