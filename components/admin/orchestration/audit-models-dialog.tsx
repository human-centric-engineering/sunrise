'use client';

/**
 * Audit Models Dialog
 *
 * Lets admins select a subset of provider models and trigger the
 * Provider Model Audit workflow. This is both a genuinely useful
 * feature (keeps the model registry accurate) and a framework
 * reference implementation that exercises 10 of 15 orchestration
 * step types end-to-end.
 *
 * On submit, creates a workflow execution and swaps the dialog body
 * from the form to an inline live-progress panel — the dialog stays
 * open until the operator dismisses it or clicks "Run in background"
 * (which closes the dialog but hands the execution id to the
 * orchestration peek-banner via localStorage). "View full details"
 * navigates to the canonical execution detail page.
 */

import React, { useCallback, useMemo, useState } from 'react';
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
 * POST to the execute endpoint and read the SSE stream just long
 * enough to pull the `workflow_started` event's `executionId` out,
 * then abort. The execution continues server-side once the engine
 * has emitted that first event (the row is already persisted) — the
 * dialog's live-poll picks up state from there. Returns `null` if
 * the stream closes before workflow_started arrives, which only
 * happens on an immediate engine error.
 */
async function executeAndCaptureId(
  workflowId: string,
  inputData: Record<string, unknown>
): Promise<string | null> {
  const controller = new AbortController();
  const res = await fetch(API.ADMIN.ORCHESTRATION.workflowExecute(workflowId), {
    method: 'POST',
    credentials: 'include',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputData }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Workflow execute failed with HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseBlock(block);
        if (parsed?.type === 'workflow_started') {
          const id = typeof parsed.data.executionId === 'string' ? parsed.data.executionId : null;
          // Abort the reader — execution row is already persisted, the
          // engine will keep running, and the dialog's live-poll will
          // surface progress without us holding the SSE connection open.
          controller.abort();
          return id;
        }
      }
    }
  } finally {
    // Belt-and-braces — release the reader even if we returned via the
    // abort path above. cancel() is a no-op once aborted.
    try {
      await reader.cancel();
    } catch {
      // Reader already cancelled; nothing to do.
    }
  }
  return null;
}

export function AuditModelsDialog({
  open,
  onOpenChange,
  models,
}: AuditModelsDialogProps): React.ReactElement {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set(models.map((m) => m.id)));
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const [, setInFlight, clearInFlight] = useLocalStorage<InFlightExecutionRef | null>(
    IN_FLIGHT_EXECUTION_STORAGE_KEY,
    null
  );

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
      // Find the audit workflow by slug. `name` is optional in the
      // response type because older fixtures don't include it; the
      // banner label falls back to the slug if the row was minimal.
      const workflows = await apiClient.get<{ id: string; slug: string; name?: string }[]>(
        API.ADMIN.ORCHESTRATION.WORKFLOWS,
        { params: { slug: AUDIT_WORKFLOW_SLUG, limit: 1 } }
      );

      const workflow = Array.isArray(workflows)
        ? workflows.find((w) => w.slug === AUDIT_WORKFLOW_SLUG)
        : null;

      if (!workflow) {
        setError(
          'Audit workflow template not found. Run db:seed to create it, or create a workflow from the "Provider Model Audit" template.'
        );
        setSubmitting(false);
        return;
      }

      // Build input data with selected model details
      const selectedModels = models.filter((m) => selected.has(m.id));
      const inputData = {
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
      const label = workflow.name ?? workflow.slug;
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
  }, [selected, models, setInFlight]);

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
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5" />
            Audit Models
            <FieldHelp
              title="Framework Reference Implementation"
              contentClassName="w-96 max-h-80 overflow-y-auto"
            >
              This dialog triggers the Provider Model Audit workflow — a 13-step DAG that exercises
              10 of 15 orchestration step types. It tests prompt chaining, routing, parallelisation,
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

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            )}
          </>
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
