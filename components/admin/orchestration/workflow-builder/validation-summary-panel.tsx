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
  UNKNOWN_TARGET: 'Broken connection',
  UNREACHABLE_STEP: 'Unreachable step',
  CYCLE_DETECTED: 'Circular loop',
  DUPLICATE_STEP_ID: 'Duplicate step name',
  MISSING_APPROVAL_PROMPT: 'Missing approval prompt',
  MISSING_CAPABILITY_SLUG: 'Missing capability',
  MISSING_GUARD_RULES: 'Missing guard rules',
  MISSING_EVALUATE_RUBRIC: 'Missing evaluation rubric',
  MISSING_EXTERNAL_URL: 'Missing external URL',
  MISSING_AGENT_SLUG: 'Missing agent',
  INSUFFICIENT_ROUTE_BRANCHES: 'Not enough routes',
  DISCONNECTED_NODE: 'Disconnected step',
  PARALLEL_WITHOUT_MERGE: 'Parallel branches never merge',
  MISSING_REQUIRED_CONFIG: 'Missing required configuration',
  DANGLING_EDGE: 'Broken connection',
};

/**
 * Human-friendly explanations per error code. These replace the raw
 * technical messages from the validator so admins can understand what
 * went wrong and how to fix it.
 */
const CODE_EXPLANATIONS: Record<string, string> = {
  MISSING_ENTRY:
    'The workflow has no starting point. Make sure one step is marked as the entry step.',
  UNKNOWN_TARGET:
    'A step connects to another step that doesn\u2019t exist. Check the connections and remove any broken links.',
  UNREACHABLE_STEP:
    'This step can\u2019t be reached from the start of the workflow. Connect it to the flow or remove it.',
  CYCLE_DETECTED:
    'Steps are connected in a loop that would run forever. Remove the connection that creates the loop.',
  DUPLICATE_STEP_ID: 'Two or more steps share the same identifier. Each step needs a unique id.',
  MISSING_APPROVAL_PROMPT:
    'This approval step needs a message explaining what the reviewer should approve.',
  MISSING_CAPABILITY_SLUG:
    'This tool call step needs a capability selected so the engine knows which tool to invoke.',
  MISSING_GUARD_RULES: 'This guard step needs validation rules so it knows what to check.',
  MISSING_EVALUATE_RUBRIC:
    'This evaluation step needs a scoring rubric so the AI knows how to rate quality.',
  MISSING_EXTERNAL_URL: 'This external call step needs a URL to know where to send the request.',
  MISSING_AGENT_SLUG:
    'This agent call step needs an agent selected so the engine knows which agent to delegate to.',
  INSUFFICIENT_ROUTE_BRANCHES:
    'A routing step needs at least two branches to be useful — otherwise just use a direct connection.',
  DISCONNECTED_NODE:
    'This step isn\u2019t connected to anything. Wire it into the flow or remove it from the canvas.',
  PARALLEL_WITHOUT_MERGE:
    'The parallel branches go in different directions and never come back together. Add a shared downstream step.',
  MISSING_REQUIRED_CONFIG:
    'This step is missing a required setting. Open the step config panel to fill it in.',
  DANGLING_EDGE: 'A connection points to a step that was deleted. Remove the broken connection.',
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
                    <span className="text-muted-foreground ml-2">
                      {CODE_EXPLANATIONS[error.code] ?? error.message}
                    </span>
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
