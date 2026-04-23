'use client';

/**
 * ValidationSummaryPanel — slide-down panel above the canvas listing the
 * union of `validateWorkflow` errors and `runExtraChecks` errors.
 *
 * Each row clicks to focus the offending node via an `onFocusNode`
 * callback the builder shell wires up to `useReactFlow().setCenter()`.
 *
 * The panel is always rendered (with `role="status"` + `aria-live`) so
 * validation state changes are announced to assistive tech without the
 * user needing to hit Validate. The Validate button just scrolls it into
 * view.
 */

import { AlertCircle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { WorkflowValidationError } from '@/lib/orchestration/workflows/validator';

import type { ExtraCheckError } from '@/components/admin/orchestration/workflow-builder/extra-checks';

export type CombinedError = WorkflowValidationError | ExtraCheckError;

export interface ValidationSummaryPanelProps {
  errors: readonly CombinedError[];
  /** Called when the user clicks an error row — builder focuses the node. */
  onFocusNode: (stepId: string) => void;
}

/** Human-readable headings per error code. */
const CODE_LABELS: Record<string, string> = {
  MISSING_ENTRY: 'Missing entry step',
  UNKNOWN_TARGET: 'Unknown target step',
  UNREACHABLE_STEP: 'Unreachable step',
  CYCLE_DETECTED: 'Cycle detected',
  DUPLICATE_STEP_ID: 'Duplicate step id',
  MISSING_APPROVAL_PROMPT: 'Missing approval prompt',
  MISSING_CAPABILITY_SLUG: 'Missing capability',
  MISSING_GUARD_RULES: 'Missing guard rules',
  MISSING_EVALUATE_RUBRIC: 'Missing evaluation rubric',
  MISSING_EXTERNAL_URL: 'Missing external URL',
  DISCONNECTED_NODE: 'Disconnected step',
  PARALLEL_WITHOUT_MERGE: 'Parallel branches never merge',
  MISSING_REQUIRED_CONFIG: 'Missing required configuration',
};

export function ValidationSummaryPanel({ errors, onFocusNode }: ValidationSummaryPanelProps) {
  const [open, setOpen] = useState(true);
  const hasErrors = errors.length > 0;

  return (
    <div
      data-testid="validation-summary-panel"
      role="status"
      aria-live="polite"
      className={cn(
        'bg-background border-b',
        hasErrors
          ? 'border-red-200 dark:border-red-900'
          : 'border-emerald-200 dark:border-emerald-900'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2 text-left text-sm"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          {hasErrors ? (
            <AlertCircle className="h-4 w-4 text-red-600" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
          )}
          <span className="font-medium">
            {hasErrors
              ? `${errors.length} issue${errors.length === 1 ? '' : 's'} found`
              : 'No issues — workflow looks good'}
          </span>
        </span>
        {hasErrors ? (
          open ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )
        ) : null}
      </button>

      {open && hasErrors && (
        <ul className="max-h-48 space-y-1 overflow-y-auto px-4 pb-3 text-xs">
          {errors.map((error, index) => {
            const heading = CODE_LABELS[error.code] ?? error.code;
            const stepId = 'stepId' in error ? error.stepId : undefined;
            return (
              <li key={`${error.code}-${index}`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto w-full justify-start px-2 py-1.5 text-left whitespace-normal"
                  onClick={() => stepId && onFocusNode(stepId)}
                  disabled={!stepId}
                >
                  <span className="flex-1">
                    <span className="font-medium text-red-700 dark:text-red-300">{heading}</span>
                    <span className="text-muted-foreground ml-2">{error.message}</span>
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
