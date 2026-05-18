'use client';

/**
 * Audit Models Dialog
 *
 * Lets admins select a subset of provider models and trigger the
 * Provider Model Audit workflow. This is both a genuinely useful
 * feature (keeps the model registry accurate) and a framework
 * reference implementation that exercises 13 of 17 orchestration
 * step types end-to-end.
 *
 * On submit, creates a workflow execution and swaps the dialog body
 * from the form to an inline live-progress panel — the dialog stays
 * open until the operator dismisses it or clicks "Run in background"
 * (which closes the dialog but hands the execution id to the
 * orchestration peek-banner via localStorage). "View full details"
 * navigates to the canonical execution detail page.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ClipboardCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FieldHelp } from '@/components/ui/field-help';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { useLocalStorage } from '@/lib/hooks/use-local-storage';
import {
  IN_FLIGHT_EXECUTION_STORAGE_KEY,
  type InFlightExecutionRef,
} from '@/lib/orchestration/in-flight-execution';
import { ExecutionProgressInline } from '@/components/admin/orchestration/execution-progress-inline';
import type { ExecutionLivePayload } from '@/lib/hooks/use-execution-live-poll';
import { TIER_ROLE_META, type TierRole } from '@/types/orchestration';
import type { ModelRow } from '@/components/admin/orchestration/provider-models-matrix';
import type { WorkflowCostEstimate } from '@/lib/orchestration/cost-estimation/workflow-cost';

interface AuditModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: ModelRow[];
}

const AUDIT_WORKFLOW_SLUG = 'tpl-provider-model-audit';

function formatAuditAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/**
 * Render a USD amount for the cost-estimate row. Sub-cent values
 * collapse to "<$0.01" so the line doesn't read as "$0.00" (which the
 * operator would read as "free").
 */
function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/**
 * POST to the execute endpoint and resolve as soon as the SSE stream
 * yields a `workflow_started` event (the row is already persisted at
 * that point, so the executionId is stable).
 *
 * CRITICAL: do NOT abort the fetch or cancel the reader. The server
 * route wires `request.signal` into `engine.execute(...)`, so a client
 * abort propagates all the way down and stops the engine mid-run —
 * exactly what we don't want. Instead we let the stream keep flowing
 * in a detached background drain (events are discarded) until the
 * workflow naturally completes server-side and the stream closes.
 *
 * Resolves to null only if the stream closes before workflow_started
 * arrives, which happens on an immediate engine validation error.
 */
async function executeAndCaptureId(
  workflowId: string,
  inputData: Record<string, unknown>
): Promise<string | null> {
  const res = await fetch(API.ADMIN.ORCHESTRATION.workflowExecute(workflowId), {
    method: 'POST',
    credentials: 'include',
    // NB: no AbortController.signal — see the comment above.
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputData }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Workflow execute failed with HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let executionId: string | null = null;

  // Read frame-by-frame until we see workflow_started; the engine
  // emits this synchronously after persisting the row, so it arrives
  // in the first SSE chunk under normal conditions.
  while (executionId === null) {
    const { value, done } = await reader.read();
    if (done) {
      return null;
    }
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const parsed = parseSseBlock(block);
      if (parsed?.type === 'workflow_started' && typeof parsed.data.executionId === 'string') {
        executionId = parsed.data.executionId;
        break;
      }
    }
  }

  // Detached drain — keep the SSE alive so the engine isn't aborted,
  // but discard every subsequent frame. Logs only on unexpected error
  // (the normal completion path is a graceful end-of-stream).
  void (async () => {
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Stream errored — engine likely finished and the connection
      // tore down. Nothing for the dialog to do here.
    }
  })();

  return executionId;
}

export function AuditModelsDialog({
  open,
  onOpenChange,
  models,
}: AuditModelsDialogProps): React.ReactElement {
  const router = useRouter();
  // Default to no models selected — operators opt in by ticking individual
  // rows or clicking "Select all". Auditing every model on every open is
  // expensive (one LLM call per model) and rarely what the operator wants.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default OFF — the audit dialog is the most frequent trigger for
  // this workflow and the supervisor incurs a billable judge-model
  // call (~$0.02–$0.10). Opt-in keeps cost predictable; operators
  // who want the honest verdict tick the box.
  const [runSupervisor, setRunSupervisor] = useState<boolean>(false);
  // Default OFF — keeps notification emails compact unless the
  // operator deliberately wants the full step-by-step report attached.
  // (The Download report button on the execution detail page is still
  // available regardless.)
  const [generateReport, setGenerateReport] = useState<boolean>(false);

  // Post-submission state — when set, the dialog body swaps from the
  // model-picker form to the live progress panel. Persists across the
  // dialog lifecycle: once an execution is started we stay in
  // "watching" mode until the operator dismisses the dialog or hits
  // a terminal status.
  const [submittedExecution, setSubmittedExecution] = useState<{
    id: string;
    workflowName: string;
    startedAt: string;
  } | null>(null);
  const [terminalStatus, setTerminalStatus] = useState<string | null>(null);

  // Audit workflow lookup. Done once on dialog-open so the cost-estimate
  // endpoint and the submit handler both reuse it. The lookup-by-slug
  // is cheap (single DB row) but redoing it on every keystroke would
  // burn rate-limit budget. `null` until the first fetch resolves.
  const [workflowMeta, setWorkflowMeta] = useState<{
    id: string;
    name: string;
  } | null>(null);

  // Cost-estimate state — driven by selected.size + runSupervisor with
  // a debounce so rapid checkbox toggles don't fan out a flurry of GETs.
  // The estimate is only shown when something is selected; an empty
  // selection has nothing useful to estimate.
  const [estimate, setEstimate] = useState<WorkflowCostEstimate | null>(null);
  const [estimateLoading, setEstimateLoading] = useState(false);

  const [, setInFlight, clearInFlight] = useLocalStorage<InFlightExecutionRef | null>(
    IN_FLIGHT_EXECUTION_STORAGE_KEY,
    null
  );

  // Resolve the audit workflow id once when the dialog opens. Subsequent
  // estimate calls + the eventual submit both use it.
  useEffect(() => {
    if (!open) return;
    if (workflowMeta !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const workflows = await apiClient.get<{ id: string; slug: string; name?: string }[]>(
          API.ADMIN.ORCHESTRATION.WORKFLOWS,
          { params: { slug: AUDIT_WORKFLOW_SLUG, limit: 1 } }
        );
        const workflow = Array.isArray(workflows)
          ? workflows.find((w) => w.slug === AUDIT_WORKFLOW_SLUG)
          : null;
        if (cancelled) return;
        if (workflow) {
          setWorkflowMeta({ id: workflow.id, name: workflow.name ?? workflow.slug });
        }
      } catch {
        // Estimate will stay null; submit handler retries the lookup.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, workflowMeta]);

  // Refresh the estimate when the selection or supervisor toggle changes.
  // Debounced so flicking through models doesn't fan out one GET per click.
  // No-op when nothing is selected (button is disabled too).
  useEffect(() => {
    if (!workflowMeta || submittedExecution) {
      setEstimate(null);
      return;
    }
    if (selected.size === 0) {
      setEstimate(null);
      setEstimateLoading(false);
      return;
    }
    let cancelled = false;
    setEstimateLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await apiClient.get<WorkflowCostEstimate>(
            API.ADMIN.ORCHESTRATION.workflowCostEstimate(workflowMeta.id),
            { params: { itemCount: selected.size, supervisor: runSupervisor } }
          );
          if (!cancelled) setEstimate(data);
        } catch {
          // Estimate is best-effort — silently drop it; the submit path
          // still works and the operator can click through.
          if (!cancelled) setEstimate(null);
        } finally {
          if (!cancelled) setEstimateLoading(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [workflowMeta, submittedExecution, selected.size, runSupervisor]);

  const providers = useMemo(() => [...new Set(models.map((m) => m.providerSlug))].sort(), [models]);

  const filtered = useMemo(() => {
    if (providerFilter === 'all') return models;
    return models.filter((m) => m.providerSlug === providerFilter);
  }, [models, providerFilter]);

  const toggleModel = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    const filteredIds = filtered.map((m) => m.id);
    const allSelected = filteredIds.every((id) => selected.has(id));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of filteredIds) {
        if (allSelected) {
          next.delete(id);
        } else {
          next.add(id);
        }
      }
      return next;
    });
  }, [filtered, selected]);

  const handleSubmit = useCallback(async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);

    try {
      // Prefer the cached metadata fetched on dialog open; fall back to
      // a fresh lookup so a slow / failed initial fetch still lets the
      // operator submit. `name` is optional in the API response because
      // older fixtures don't include it; the banner label falls back to
      // the slug when the row was minimal.
      let workflow: { id: string; name: string } | null = workflowMeta;
      if (!workflow) {
        const workflows = await apiClient.get<{ id: string; slug: string; name?: string }[]>(
          API.ADMIN.ORCHESTRATION.WORKFLOWS,
          { params: { slug: AUDIT_WORKFLOW_SLUG, limit: 1 } }
        );
        const found = Array.isArray(workflows)
          ? workflows.find((w) => w.slug === AUDIT_WORKFLOW_SLUG)
          : null;
        workflow = found ? { id: found.id, name: found.name ?? found.slug } : null;
      }

      if (!workflow) {
        setError(
          'Audit workflow template not found. Run db:seed to create it, or create a workflow from the "Provider Model Audit" template.'
        );
        setSubmitting(false);
        return;
      }

      // Build input data with selected model details. `__runSupervisor`
      // is a reserved key consumed by the `supervisor` step executor —
      // when explicitly false, the step short-circuits with expectedSkip
      // and the audit produces no honest-audit verdict for this run.
      const selectedModels = models.filter((m) => selected.has(m.id));
      const inputData: Record<string, unknown> = {
        modelIds: selectedModels.map((m) => m.id),
        models: selectedModels.map((m) => ({
          id: m.id,
          name: m.name,
          modelId: m.modelId,
          providerSlug: m.providerSlug,
          capabilities: m.capabilities,
          tierRole: m.tierRole,
          reasoningDepth: m.reasoningDepth,
          latency: m.latency,
          costEfficiency: m.costEfficiency,
          contextLength: m.contextLength,
          toolUse: m.toolUse,
          bestRole: m.bestRole,
          dimensions: m.dimensions,
          schemaCompatible: m.schemaCompatible,
        })),
        __runSupervisor: runSupervisor,
        __generateReport: generateReport,
      };

      // Execute the workflow. The endpoint returns SSE — not a JSON
      // `{ id }` — because the engine emits step-level events on the
      // same connection. We only need the executionId from the very
      // first event (`workflow_started`), so we read just enough of
      // the stream to capture it and then abort. The execution keeps
      // running server-side regardless; the live-poll hook inside
      // ExecutionProgressInline takes over from there.
      const executionId = await executeAndCaptureId(workflow.id, inputData);
      if (!executionId) {
        setError('Audit started but the server did not return an execution id.');
        setSubmitting(false);
        return;
      }

      const startedAt = new Date().toISOString();
      const label = workflow.name;
      setSubmittedExecution({
        id: executionId,
        workflowName: label,
        startedAt,
      });
      setInFlight({
        executionId,
        label,
        startedAt,
      });
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start audit');
      setSubmitting(false);
    }
  }, [selected, models, runSupervisor, generateReport, setInFlight, workflowMeta]);

  const allFilteredSelected = filtered.every((m) => selected.has(m.id));

  /**
   * Dialog dismiss semantics — Esc / overlay click / "Run in background"
   * route through this. Behaviour depends on dialog phase:
   *   - No execution yet (idle form) → close normally, no localStorage
   *     side-effect.
   *   - Execution running → close and KEEP the localStorage handoff so
   *     the orchestration peek-banner picks the run up.
   *   - Execution terminal → close AND clear the handoff so a stale
   *     banner doesn't linger.
   * `keepInFlight` forces the running-state semantics from the "View
   * full details" button so the banner survives the navigation.
   */
  const handleDismiss = useCallback(
    (opts?: { keepInFlight?: boolean }) => {
      const isRunning =
        submittedExecution !== null && terminalStatus === null && !opts?.keepInFlight;
      if (submittedExecution && (terminalStatus !== null || opts?.keepInFlight === false)) {
        clearInFlight();
      } else if (!isRunning && submittedExecution === null) {
        // Idle form dismissal — no-op on localStorage.
      }
      onOpenChange(false);
    },
    [submittedExecution, terminalStatus, clearInFlight, onOpenChange]
  );

  const initialLivePayload: ExecutionLivePayload | null = submittedExecution
    ? {
        snapshot: {
          id: submittedExecution.id,
          status: 'pending',
          currentStep: null,
          errorMessage: null,
          totalTokensUsed: 0,
          totalCostUsd: 0,
          startedAt: submittedExecution.startedAt,
          completedAt: null,
          createdAt: submittedExecution.startedAt,
        },
        trace: [],
        costEntries: [],
        currentStepDetails: null,
      }
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) handleDismiss();
        else onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[90vh] flex-col gap-4 sm:max-w-[920px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Audit Models
            <FieldHelp
              title="Framework Reference Implementation"
              contentClassName="w-96 max-h-80 overflow-y-auto"
            >
              This dialog triggers the Provider Model Audit workflow — a 19-step DAG that exercises
              13 of 17 orchestration step types. It tests prompt chaining, routing, parallelisation,
              reflection, tool use, guardrails, evaluation, human-in-the-loop approval, RAG
              retrieval, and notifications. Selected model IDs become the workflow&apos;s{' '}
              <code>inputData</code>, testing the engine&apos;s input parameter passing and template
              interpolation.
            </FieldHelp>
          </DialogTitle>
          <DialogDescription>
            Select the models to audit. The AI will evaluate each model&apos;s classification and
            propose changes for your review. Models only need re-auditing every few months, or
            sooner if you notice inaccuracies in tier or capability ratings.
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-2 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-2">
          {submittedExecution && initialLivePayload ? (
            <ExecutionProgressInline
              executionId={submittedExecution.id}
              initialPayload={initialLivePayload}
              onTerminal={(status) => setTerminalStatus(status)}
            />
          ) : (
            <>
              {/* Filter */}
              <div className="flex items-center gap-3">
                <Select value={providerFilter} onValueChange={setProviderFilter}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Filter by provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All providers</SelectItem>
                    {providers.map((p) => (
                      <SelectItem key={p} value={p} className="capitalize">
                        {p}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button variant="ghost" size="sm" onClick={toggleAll}>
                  {allFilteredSelected ? 'Deselect all' : 'Select all'}
                </Button>

                <span className="text-muted-foreground ml-auto text-sm">
                  {selected.size} of {models.length} selected
                </span>
              </div>

              {/* Model list */}
              <div className="max-h-[300px] overflow-y-auto rounded-md border">
                {filtered.length === 0 && (
                  <p className="text-muted-foreground p-4 text-center text-sm">
                    No models match the selected provider filter.
                  </p>
                )}
                <div className="divide-y">
                  {filtered.map((model) => (
                    <div
                      key={model.id}
                      role="button"
                      tabIndex={0}
                      className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-3 py-2"
                      onClick={() => toggleModel(model.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleModel(model.id);
                        }
                      }}
                    >
                      <Checkbox
                        checked={selected.has(model.id)}
                        onCheckedChange={() => toggleModel(model.id)}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                        aria-label={`Select ${model.name} for audit`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{model.name}</span>
                          <Badge variant="secondary" className="shrink-0 text-[10px]">
                            {TIER_ROLE_META[model.tierRole as TierRole]?.label ?? model.tierRole}
                          </Badge>
                          {model.capabilities.includes('embedding') && (
                            <Badge
                              variant="outline"
                              className="shrink-0 bg-amber-100 text-[10px] text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                            >
                              Embedding
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-muted-foreground text-xs">
                            {model.providerSlug} / {model.modelId}
                          </span>
                          <span className="text-muted-foreground/50 text-[10px]">
                            {model.metadata?.lastAudit?.timestamp
                              ? `Audited ${formatAuditAge(model.metadata.lastAudit.timestamp)}`
                              : 'Never audited'}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Run-time supervisor toggle — opts the supervisor_review
                  step in/out per-execution. Default ON (the audit's
                  primary value prop is honest assessment of its own
                  work). When unchecked, inputData.__runSupervisor is
                  set to false and the executor short-circuits with
                  expectedSkip. */}
              <div className="bg-muted/30 flex items-start gap-3 rounded-md border px-3 py-2">
                <Checkbox
                  id="audit-run-supervisor"
                  checked={runSupervisor}
                  onCheckedChange={(next) => setRunSupervisor(next === true)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <label
                    htmlFor="audit-run-supervisor"
                    className="flex cursor-pointer items-center gap-2 text-sm font-medium"
                  >
                    Run neutral supervisor review
                    <FieldHelp
                      title="Neutral supervisor review"
                      contentClassName="w-96 max-h-80 overflow-y-auto"
                    >
                      A separate judge model audits the workflow&apos;s execution after it completes
                      — looking at every step&apos;s output, the validator&apos;s decisions, and the
                      changes actually applied — and produces an evidence-cited verdict (pass /
                      concerns / fail). Designed to catch problems that the workflow&apos;s own
                      optimistic summary would miss. Adds one judge-model LLM call (typically
                      $0.02–$0.10) to the audit&apos;s cost. Uncheck to skip on a tight budget.
                    </FieldHelp>
                  </label>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Independent post-hoc assessment of audit quality. Adds ~one LLM call.
                  </p>
                </div>
              </div>

              {/* Run-time report toggle — opts the `report_render` step
                  in/out per-execution. Default OFF. When unchecked,
                  inputData.__generateReport is set to false and the
                  executor short-circuits; the notification email's
                  {{report_render.output.markdown}} interpolation resolves
                  to empty. The Download Report button on the execution
                  detail page is unaffected — it renders the trace fresh
                  on click regardless of this toggle. */}
              <div className="bg-muted/30 flex items-start gap-3 rounded-md border px-3 py-2">
                <Checkbox
                  id="audit-generate-report"
                  checked={generateReport}
                  onCheckedChange={(next) => setGenerateReport(next === true)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <label
                    htmlFor="audit-generate-report"
                    className="flex cursor-pointer items-center gap-2 text-sm font-medium"
                  >
                    Include detailed report in notification email
                    <FieldHelp
                      title="Detailed report in email"
                      contentClassName="w-96 max-h-80 overflow-y-auto"
                    >
                      <p>
                        When checked, the audit&apos;s notification email body includes a full
                        step-by-step Markdown rendering of the trace — every step&apos;s inputs,
                        outputs, durations, and costs. Useful for recipients who don&apos;t have
                        admin access, audit-trail forwarding, or compliance archives.
                      </p>
                      <p className="mt-2">
                        When unchecked, the email contains only the supervisor verdict (if enabled)
                        and the agent-written executive summary. The email stays short.
                      </p>
                      <p className="mt-2">
                        <strong>This setting does not gate access to the report.</strong> The
                        <strong> Download report</strong> button on the execution detail page
                        renders the same Markdown fresh from the trace on every click, regardless of
                        whether this box was ticked at trigger time.
                      </p>
                      <p className="mt-2">No LLM cost either way — this is pure formatting.</p>
                    </FieldHelp>
                  </label>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Embeds the full step-by-step report inline in the email. Download button works
                    regardless.
                  </p>
                </div>
              </div>

              {error && (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        {!submittedExecution && selected.size > 0 && (estimateLoading || estimate) && (
          <div
            className="text-muted-foreground flex items-center justify-end gap-1.5 border-t pt-3 text-xs"
            data-testid="audit-cost-estimate"
          >
            {estimate ? (
              <>
                <span>
                  Estimated cost:{' '}
                  <span className="text-foreground font-medium">~{formatUsd(estimate.midUsd)}</span>{' '}
                  <span className="text-muted-foreground/70">
                    (range {formatUsd(estimate.lowUsd)}–{formatUsd(estimate.highUsd)})
                  </span>
                </span>
                <FieldHelp title="How the cost is estimated" contentClassName="w-80">
                  <p>{estimate.notes}</p>
                  <p className="mt-2">
                    <strong>Model{estimate.judgeModelUsed ? 's' : ''}:</strong> non-supervisor steps
                    priced against <code>{estimate.modelUsed}</code> (the configured chat default).
                    {estimate.judgeModelUsed ? (
                      <>
                        {' '}
                        Supervisor step priced against <code>{estimate.judgeModelUsed}</code>
                        {estimate.judgeModelUsed === estimate.modelUsed ? (
                          <>
                            {' '}
                            (same as the chat default — set <code>EVALUATION_JUDGE_MODEL</code> to
                            give the supervisor an independent judge)
                          </>
                        ) : null}
                        .
                      </>
                    ) : (
                      '.'
                    )}
                  </p>
                  <p className="mt-2">
                    <strong>Source:</strong>{' '}
                    {estimate.basedOn === 'empirical'
                      ? `past run history (${estimate.sampleSize} match${
                          estimate.sampleSize === 1 ? '' : 'es'
                        })`
                      : 'heuristic — fixed token assumptions repriced at the current model rates'}
                    .
                  </p>
                  <p className="mt-2">
                    Actual cost depends on prompt evolution, retry behaviour, and any agent tool-use
                    iterations — treat this as planning-grade, not a quote.
                  </p>
                </FieldHelp>
              </>
            ) : (
              <span>Estimating cost…</span>
            )}
          </div>
        )}

        <DialogFooter>
          {submittedExecution ? (
            terminalStatus === null ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDismiss()}
                  data-testid="audit-run-in-background"
                >
                  Run in background
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    handleDismiss({ keepInFlight: true });
                    router.push(`/admin/orchestration/executions/${submittedExecution.id}`);
                  }}
                  data-testid="audit-view-full-details"
                >
                  View full details
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleDismiss()}
                  data-testid="audit-close-after-terminal"
                >
                  Close
                </Button>
                <Button
                  type="button"
                  onClick={() => {
                    handleDismiss();
                    router.push(`/admin/orchestration/executions/${submittedExecution.id}`);
                  }}
                >
                  Open detail page
                </Button>
              </>
            )
          ) : (
            <>
              <Button variant="outline" onClick={() => handleDismiss()} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={submitting || selected.size === 0}
              >
                {submitting
                  ? 'Starting audit...'
                  : `Audit ${selected.size} model${selected.size !== 1 ? 's' : ''}`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
