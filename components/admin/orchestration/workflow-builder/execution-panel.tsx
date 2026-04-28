'use client';

/**
 * ExecutionPanel — the live execution side panel rendered when the
 * builder's Execute button is clicked.
 *
 * Opens `POST /workflows/:id/execute` as an SSE stream, parses
 * `ExecutionEvent` frames, and renders a per-step timeline with totals,
 * an abort button, and an approve button when a `human_approval` step
 * is active.
 *
 * SSE parsing mirrors `agent-test-chat.tsx` — naked `reader.read()`
 * + `\n\n`-split + `parseSseBlock()` helper. No `EventSource` (it
 * can't POST a JSON body).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, StopCircle, ThumbsUp, X, XCircle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiClient, APIClientError } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { cn } from '@/lib/utils';
import type { ExecutionTraceEntry } from '@/types/orchestration';

import { ExecutionTraceEntryRow } from '@/components/admin/orchestration/workflow-builder/execution-trace-entry';

type PanelStatus = 'idle' | 'running' | 'completed' | 'failed' | 'awaiting_approval' | 'aborted';

interface LiveTraceEntry {
  stepId: string;
  stepType: string;
  label: string;
  status: ExecutionTraceEntry['status'] | 'running';
  output?: unknown;
  error?: string;
  tokensUsed?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface ExecutionPanelProps {
  open: boolean;
  workflowId: string;
  inputData: Record<string, unknown>;
  budgetLimitUsd?: number;
  resumeFromExecutionId?: string;
  onClose: () => void;
}

interface ParsedFrame {
  type: string;
  data: Record<string, unknown>;
}

export function ExecutionPanel({
  open,
  workflowId,
  inputData,
  budgetLimitUsd,
  resumeFromExecutionId,
  onClose,
}: ExecutionPanelProps) {
  const [status, setStatus] = useState<PanelStatus>('idle');
  const [entries, setEntries] = useState<LiveTraceEntry[]>([]);
  const [totalTokens, setTotalTokens] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [approvingStepId, setApprovingStepId] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [budgetWarning, setBudgetWarning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const streamRun = useCallback(
    async (resumeId?: string) => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setStatus('running');
      setErrorMessage(null);
      if (!resumeId) {
        setEntries([]);
        setTotalTokens(0);
        setTotalCost(0);
        setBudgetWarning(null);
        setApprovingStepId(null);
        setExecutionId(null);
      }

      const url = resumeId
        ? `${API.ADMIN.ORCHESTRATION.workflowExecute(workflowId)}?resumeFromExecutionId=${encodeURIComponent(resumeId)}`
        : API.ADMIN.ORCHESTRATION.workflowExecute(workflowId);

      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputData, budgetLimitUsd }),
        });

        if (!res.ok || !res.body) {
          setStatus('failed');
          setErrorMessage('Execution failed to start. Check server logs for details.');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sepIndex;
          while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);
            const parsed = parseSseBlock(block);
            if (parsed) applyEvent(parsed);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          setStatus((prev) => (prev === 'running' ? 'aborted' : prev));
          return;
        }
        logger.error('Execution stream failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        setStatus('failed');
        setErrorMessage('Connection to the execution stream was lost.');
      } finally {
        abortRef.current = null;
      }
    },
    [workflowId, inputData, budgetLimitUsd]
  );

  const applyEvent = useCallback((frame: ParsedFrame): void => {
    const d = frame.data;
    const eventType = typeof d.type === 'string' ? d.type : null;
    if (!eventType) return;

    switch (eventType) {
      case 'workflow_started':
        if (typeof d.executionId === 'string') setExecutionId(d.executionId);
        break;
      case 'step_started':
        if (typeof d.stepId === 'string' && typeof d.label === 'string') {
          setEntries((prev) => [
            ...prev,
            {
              stepId: d.stepId as string,
              stepType: typeof d.stepType === 'string' ? d.stepType : 'unknown',
              label: d.label as string,
              status: 'running',
              tokensUsed: 0,
              costUsd: 0,
            },
          ]);
        }
        break;
      case 'step_completed': {
        const stepId = typeof d.stepId === 'string' ? d.stepId : null;
        const tokensUsed = typeof d.tokensUsed === 'number' ? d.tokensUsed : 0;
        const costUsd = typeof d.costUsd === 'number' ? d.costUsd : 0;
        const durationMs = typeof d.durationMs === 'number' ? d.durationMs : undefined;
        if (stepId) {
          setEntries((prev) =>
            prev.map((e) =>
              e.stepId === stepId
                ? { ...e, status: 'completed', output: d.output, tokensUsed, costUsd, durationMs }
                : e
            )
          );
          setTotalTokens((prev) => prev + tokensUsed);
          setTotalCost((prev) => prev + costUsd);
        }
        break;
      }
      case 'step_failed': {
        const stepId = typeof d.stepId === 'string' ? d.stepId : null;
        if (stepId) {
          setEntries((prev) =>
            prev.map((e) =>
              e.stepId === stepId
                ? {
                    ...e,
                    status: d.willRetry ? 'running' : 'failed',
                    error: typeof d.error === 'string' ? d.error : 'Unknown error',
                  }
                : e
            )
          );
        }
        break;
      }
      case 'approval_required': {
        const stepId = typeof d.stepId === 'string' ? d.stepId : null;
        if (stepId) {
          setStatus('awaiting_approval');
          setApprovingStepId(stepId);
          setEntries((prev) =>
            prev.map((e) =>
              e.stepId === stepId ? { ...e, status: 'awaiting_approval', output: d.payload } : e
            )
          );
        }
        break;
      }
      case 'budget_warning': {
        const usedUsd = typeof d.usedUsd === 'number' ? d.usedUsd : 0;
        const limitUsd = typeof d.limitUsd === 'number' ? d.limitUsd : 0;
        if (limitUsd > 0) {
          setBudgetWarning(
            `Used $${usedUsd.toFixed(4)} of $${limitUsd.toFixed(4)} budget (${Math.round(
              (usedUsd / limitUsd) * 100
            )}%).`
          );
        }
        break;
      }
      case 'workflow_completed':
        setStatus('completed');
        break;
      case 'workflow_failed':
        setStatus('failed');
        setErrorMessage(typeof d.error === 'string' ? d.error : 'Workflow failed');
        break;
      case 'error':
        // Terminal error frame from the SSE bridge (stream_error).
        setStatus('failed');
        setErrorMessage(
          typeof d.message === 'string' ? d.message : 'Stream terminated unexpectedly'
        );
        break;
    }
  }, []);

  // Open trigger — kick off the stream whenever `open` flips true.
  useEffect(() => {
    if (!open) return;
    void streamRun(resumeFromExecutionId);
    return () => {
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleAbort = useCallback(() => {
    if (executionId) {
      // Best-effort: persist cancellation in DB so the engine also stops.
      apiClient.post(API.ADMIN.ORCHESTRATION.executionCancel(executionId)).catch(() => {
        /* best-effort */
      });
    }
    abortRef.current?.abort();
  }, [executionId]);

  const handleApprove = useCallback(async () => {
    if (!executionId) return;
    try {
      await apiClient.post(API.ADMIN.ORCHESTRATION.executionApprove(executionId), {
        body: { approvalPayload: { approved: true } },
      });
      // Reconnect to drain remaining events.
      void streamRun(executionId);
    } catch (err) {
      const message =
        err instanceof APIClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Approval failed';
      setErrorMessage(message);
    }
  }, [executionId, streamRun]);

  const handleRetryStep = useCallback(
    async (stepId: string) => {
      if (!executionId) return;
      try {
        await apiClient.post(API.ADMIN.ORCHESTRATION.executionRetryStep(executionId), {
          body: { stepId },
        });
        // Remove entries from the failed step onward in the UI
        setEntries((prev) => {
          const idx = prev.findIndex((e) => e.stepId === stepId);
          return idx === -1 ? prev : prev.slice(0, idx);
        });
        setErrorMessage(null);
        // Reconnect to resume from the step before the failed one
        void streamRun(executionId);
      } catch (err) {
        const message =
          err instanceof APIClientError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Retry failed';
        setErrorMessage(message);
      }
    },
    [executionId, streamRun]
  );

  const headerIcon = useMemo(() => {
    switch (status) {
      case 'running':
        return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
      case 'completed':
        return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'failed':
      case 'aborted':
        return <XCircle className="h-4 w-4 text-red-500" />;
      default:
        return null;
    }
  }, [status]);

  if (!open) return null;

  return (
    <aside
      data-testid="execution-panel"
      className="bg-background flex h-full w-[420px] flex-col border-l"
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        {headerIcon}
        <h2 className="flex-1 text-sm font-medium">Execution</h2>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close execution panel"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="border-b px-4 py-3 text-xs">
        <div className="grid grid-cols-3 gap-2">
          <div>
            <div className="text-muted-foreground">Status</div>
            <div className="font-medium capitalize">{status.replace(/_/g, ' ')}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Tokens</div>
            <div className="font-medium">{totalTokens.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Cost</div>
            <div className="font-medium">${totalCost.toFixed(4)}</div>
          </div>
        </div>

        {status === 'running' && (
          <Button size="sm" variant="outline" className="mt-3 w-full" onClick={handleAbort}>
            <StopCircle className="mr-2 h-4 w-4" />
            Abort
          </Button>
        )}

        {status === 'awaiting_approval' && approvingStepId && (
          <Button size="sm" className="mt-3 w-full" onClick={() => void handleApprove()}>
            <ThumbsUp className="mr-2 h-4 w-4" />
            Approve &amp; continue
          </Button>
        )}
      </div>

      {budgetWarning && (
        <div
          role="alert"
          className={cn(
            'flex items-center gap-2 border-b px-4 py-2 text-xs',
            'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
          )}
        >
          <AlertCircle className="h-4 w-4" />
          <span>{budgetWarning}</span>
        </div>
      )}

      {errorMessage && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b bg-red-50 px-4 py-2 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-200"
        >
          <AlertCircle className="h-4 w-4" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {entries.length === 0 ? (
          <p className="text-muted-foreground text-center text-xs">Waiting for first step…</p>
        ) : (
          entries.map((entry, idx) => (
            <ExecutionTraceEntryRow
              key={`${entry.stepId}-${idx}`}
              stepId={entry.stepId}
              stepType={String(entry.stepType)}
              label={entry.label}
              status={entry.status}
              output={entry.output}
              error={entry.error}
              tokensUsed={entry.tokensUsed ?? 0}
              costUsd={entry.costUsd ?? 0}
              durationMs={entry.durationMs}
              onRetry={status === 'failed' ? (sid) => void handleRetryStep(sid) : undefined}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function parseSseBlock(block: string): ParsedFrame | null {
  const lines = block.split('\n');
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventType = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!eventType || dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    return { type: eventType, data };
  } catch {
    return null;
  }
}
