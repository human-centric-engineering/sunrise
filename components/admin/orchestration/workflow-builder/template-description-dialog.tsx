'use client';

/**
 * TemplateDescriptionDialog — shown when an admin picks a built-in
 * template from the toolbar dropdown. Displays the template's name,
 * short description, pattern badges, and flow summary, then confirms
 * the canvas replacement.
 *
 * Behaviour:
 *  - `template === null` → dialog not rendered (controlled via `open`).
 *  - `canvasHasContent === true` → the confirm button changes copy to
 *    "Replace canvas with template" and a warning note is shown so the
 *    user doesn't accidentally clobber in-progress work.
 *  - Confirm fires `onConfirm()`; the shell is responsible for the
 *    actual canvas populate via `workflowDefinitionToFlow`.
 */

import { AlertTriangle } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import type { WorkflowTemplate } from '@/lib/orchestration/workflows/templates';

export interface TemplateDescriptionDialogProps {
  open: boolean;
  template: WorkflowTemplate | null;
  /** True if the current canvas already has nodes — swaps button copy + warning. */
  canvasHasContent: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function TemplateDescriptionDialog({
  open,
  template,
  canvasHasContent,
  onOpenChange,
  onConfirm,
}: TemplateDescriptionDialogProps) {
  if (!template) {
    return null;
  }

  const confirmLabel = canvasHasContent ? 'Replace canvas with template' : 'Use this template';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{template.name}</DialogTitle>
          <DialogDescription>{template.shortDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Patterns used
            </p>
            <div className="flex flex-wrap gap-1.5">
              {template.patterns.map((pattern) => (
                <Badge key={pattern.number} variant="secondary">
                  #{pattern.number} {pattern.name}
                </Badge>
              ))}
            </div>
          </div>

          {template.useCases.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                Use cases
              </p>
              <ul className="space-y-1.5 text-sm">
                {template.useCases.map((uc) => (
                  <li key={uc.title}>
                    <span className="font-medium">{uc.title}</span>
                    <span className="text-muted-foreground"> — {uc.scenario}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              Flow
            </p>
            <p className="text-sm leading-relaxed">{template.flowSummary}</p>
          </div>

          {canvasHasContent && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                The canvas already has steps. Loading this template will replace every node and edge
                on the canvas — any unsaved work will be lost.
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
