'use client';

/**
 * EvaluationRunner (Phase 7 Session 7.1, revised Phase 7.2)
 *
 * Split-panel evaluation experience:
 *   - Left: inline SSE chat connected to the evaluation's agent
 *   - Right: per-message annotation tools (category, rating, notes)
 *
 * Annotations are stored in React state and persisted to the session's
 * `metadata` field as flat keys (the metadataSchema only allows
 * Record<string, string|number|boolean|null>, max 100 keys).
 *
 * On completion, triggers AI analysis via the /complete endpoint and
 * displays the generated summary and improvement suggestions.
 *
 * Revisions (7.2):
 *   - Fixed stale closure in auto-save (uses ref for current annotations)
 *   - Loads existing logs on mount for resumable in-progress evaluations
 *   - Shows conversation transcript in completed view
 *   - Confirmation dialog before irreversible completion
 *   - Manual save button + annotation limit warning
 *   - Archive button for non-completed evaluations
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  Save,
  Send,
} from 'lucide-react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { parseChatStreamEvent } from '@/components/admin/orchestration/chat/chat-events';
import { MessageTrace } from '@/components/admin/orchestration/chat/message-trace';
import type { ToolCallTrace } from '@/types/orchestration';
import {
  type Annotation,
  CATEGORIES,
  serializeAnnotations,
  deserializeAnnotations,
} from '@/lib/orchestration/evaluations/annotation-serializer';
import { EvaluationMetricChips } from '@/components/admin/orchestration/evaluation-metric-chips';
import { useTypingAnimation } from '@/lib/hooks/use-typing-animation';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Max non-default annotations that fit in 100 metadata keys (4 keys each + ann_count). */
const MAX_ANNOTATIONS = 24;
/** Warn when this many annotation slots remain. */
const ANNOTATION_WARN_THRESHOLD = 4;

// ─── Types ──────────────────────────────────────────────────────────────────

interface EvaluationSession {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  summary?: string | null;
  improvementSuggestions?: string[] | null;
  agent?: { id: string; name: string; slug: string } | null;
  createdAt: string;
  completedAt?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Aggregate metric summary populated when the session has been scored. */
  metricSummary?: MetricSummary | null;
}

export interface EvaluationRunnerProps {
  evaluation: EvaluationSession;
}

interface JudgeReasoning {
  faithfulness?: { reasoning: string };
  groundedness?: { reasoning: string };
  relevance?: { reasoning: string };
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Set on assistant messages restored from completed/scored logs. */
  scores?: {
    faithfulness: number | null;
    groundedness: number | null;
    relevance: number | null;
    reasoning?: JudgeReasoning;
  };
  /**
   * Per-capability dispatch diagnostics for the assistant turn —
   * populated from `capability_result.trace` frames. Drives the
   * inline `<MessageTrace>` strip rendered under the bubble.
   */
  toolCalls?: ToolCallTrace[];
}

interface MetricSummary {
  avgFaithfulness: number | null;
  avgGroundedness: number | null;
  avgRelevance: number | null;
  scoredLogCount: number;
  judgeProvider: string;
  judgeModel: string;
  scoredAt: string;
  totalScoringCostUsd: number;
}

interface CompletionResult {
  summary: string;
  improvementSuggestions: string[];
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
  metricSummary?: MetricSummary | null;
}

interface LogEntry {
  sequenceNumber: number;
  eventType: string;
  content: string | null;
  faithfulnessScore?: number | null;
  groundednessScore?: number | null;
  relevanceScore?: number | null;
  judgeReasoning?: JudgeReasoning | null;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EvaluationRunner({ evaluation }: EvaluationRunnerProps) {
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  // Annotation state
  const [annotations, setAnnotations] = useState<Map<number, Annotation>>(() =>
    deserializeAnnotations(
      evaluation.metadata &&
        typeof evaluation.metadata === 'object' &&
        !Array.isArray(evaluation.metadata)
        ? evaluation.metadata
        : null
    )
  );
  const [expandedMsg, setExpandedMsg] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);

  // Completion state
  const [isCompleting, setIsCompleting] = useState(false);
  const [completionResult, setCompletionResult] = useState<CompletionResult | null>(
    evaluation.status === 'completed' && evaluation.summary
      ? {
          summary: evaluation.summary,
          improvementSuggestions: evaluation.improvementSuggestions ?? [],
          metricSummary: evaluation.metricSummary ?? null,
        }
      : null
  );
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [isRescoring, setIsRescoring] = useState(false);
  const [rescoreError, setRescoreError] = useState<string | null>(null);

  // Status
  const [currentStatus, setCurrentStatus] = useState(evaluation.status);

  // Archive state
  const [isArchiving, setIsArchiving] = useState(false);

  // Refs
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const statusPatched = useRef(false);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  // Terminal-style typing animation for streamed assistant replies.
  const typing = useTypingAnimation({ chunkSize: 2 });

  // Sync animated text into the last assistant message.
  useEffect(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      if (last.content === typing.displayText) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...last, content: typing.displayText };
      return updated;
    });
  }, [typing.displayText]);

  const isCompleted = currentStatus === 'completed';
  const isArchived = currentStatus === 'archived';
  const agentSlug = evaluation.agent?.slug;

  // Count non-default annotations for limit warning
  const activeAnnotationCount = countActiveAnnotations(annotations);
  const remainingSlots = MAX_ANNOTATIONS - activeAnnotationCount;
  const showLimitWarning = remainingSlots <= ANNOTATION_WARN_THRESHOLD && remainingSlots > 0;
  const atLimit = remainingSlots <= 0;

  // Scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Abort on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Auto-PATCH status to in_progress on mount
  useEffect(() => {
    if (statusPatched.current || evaluation.status !== 'draft') return;
    statusPatched.current = true;
    void fetch(API.ADMIN.ORCHESTRATION.evaluationById(evaluation.id), {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress', startedAt: new Date().toISOString() }),
    }).then((res) => {
      if (res.ok) setCurrentStatus('in_progress');
    });
  }, [evaluation.id, evaluation.status]);

  // Load existing logs on mount for resumable evaluations
  useEffect(() => {
    if (evaluation.status === 'completed' || evaluation.status === 'archived') return;
    void loadExistingLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadExistingLogs() {
    setLogsLoading(true);
    try {
      const res = await fetch(
        `${API.ADMIN.ORCHESTRATION.evaluationLogs(evaluation.id)}?limit=500`,
        { credentials: 'include' }
      );
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { logs?: LogEntry[] } };
      const logs = body?.data?.logs;
      if (!logs || logs.length === 0) return;

      const restored = logsToMessages(logs);
      if (restored.length > 0) {
        setMessages(restored);
      }
    } catch {
      // Non-critical — user can still start fresh
    } finally {
      setLogsLoading(false);
    }
  }

  // ─── Chat ───────────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming || !agentSlug) return;

      setChatError(null);
      setInput('');
      typing.reset();
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '' },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(API.ADMIN.ORCHESTRATION.CHAT_STREAM, {
          method: 'POST',
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentSlug,
            message: trimmed,
            conversationId: conversationId ?? undefined,
            contextType: 'evaluation',
            contextId: evaluation.id,
            // Evaluation runner is an admin-only surface — opt into the
            // diagnostic trace so reviewers see why each turn was
            // produced (which capabilities, with what args, latency).
            includeTrace: true,
          }),
        });

        if (!res.ok || !res.body) {
          setChatError('Chat stream failed to start. Try again in a moment.');
          setMessages((prev) => prev.slice(0, -1));
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
            if (!parsed) continue;

            if (parsed.type === 'start') {
              const cid = parsed.data.conversationId;
              if (typeof cid === 'string') setConversationId(cid);
            } else if (parsed.type === 'content' && typeof parsed.data.delta === 'string') {
              const delta = parsed.data.delta;
              typing.appendDelta(delta);
            } else if (
              parsed.type === 'capability_result' ||
              parsed.type === 'capability_results'
            ) {
              // Re-validate through the typed parser so we never push
              // raw server payloads into UI state. The parser also
              // discards malformed `trace` shapes silently.
              const typed = parseChatStreamEvent(block);
              const traces: ToolCallTrace[] = [];
              if (typed?.type === 'capability_result' && typed.trace) {
                traces.push(typed.trace);
              } else if (typed?.type === 'capability_results') {
                for (const entry of typed.results) {
                  if (entry.trace) traces.push(entry.trace);
                }
              }
              if (traces.length > 0) {
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (!last || last.role !== 'assistant') return prev;
                  updated[updated.length - 1] = {
                    ...last,
                    toolCalls: [...(last.toolCalls ?? []), ...traces],
                  };
                  return updated;
                });
              }
            } else if (parsed.type === 'error') {
              typing.flush();
              setChatError('The agent ran into a problem. Check the server logs for details.');
              return;
            } else if (parsed.type === 'done') {
              typing.flush();
              return;
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setChatError('Could not reach the chat stream. Try again in a moment.');
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [agentSlug, conversationId, streaming, evaluation.id, typing]
  );

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  // ─── Annotations ────────────────────────────────────────────────────────

  const updateAnnotation = useCallback((msgIdx: number, update: Partial<Annotation>) => {
    setAnnotations((prev) => {
      const next = new Map(prev);
      const existing = next.get(msgIdx) ?? { category: null, rating: 3, notes: '' };
      next.set(msgIdx, { ...existing, ...update });
      return next;
    });

    // Debounced auto-save using ref to avoid stale closure
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      void persistAnnotations();
    }, 30_000);
  }, []);

  /** Persist current annotations to server — uses ref to always get latest state. */
  const persistAnnotations = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.evaluationById(evaluation.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: serializeAnnotations(annotationsRef.current) }),
      });
      if (res.ok) setLastSaved(new Date());
    } catch {
      // Silent — auto-save is best-effort
    } finally {
      setSaving(false);
    }
  }, [evaluation.id]);

  /** Manual save triggered by button click */
  const handleManualSave = useCallback(() => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    void persistAnnotations();
  }, [persistAnnotations]);

  // ─── Archive ────────────────────────────────────────────────────────────

  const handleArchive = useCallback(async () => {
    setIsArchiving(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.evaluationById(evaluation.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'archived' }),
      });
      if (res.ok) setCurrentStatus('archived');
    } catch {
      // Non-critical — user can retry
    } finally {
      setIsArchiving(false);
    }
  }, [evaluation.id]);

  // ─── Complete ───────────────────────────────────────────────────────────

  const handleComplete = useCallback(async () => {
    setIsCompleting(true);
    setCompletionError(null);

    try {
      // Save annotations first using ref for latest state
      await fetch(API.ADMIN.ORCHESTRATION.evaluationById(evaluation.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: serializeAnnotations(annotationsRef.current) }),
      });

      // Trigger AI analysis
      const res = await fetch(API.ADMIN.ORCHESTRATION.evaluationComplete(evaluation.id), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        const msg = body?.error?.message ?? 'Failed to complete evaluation. Please try again.';
        setCompletionError(msg);
        return;
      }

      const body = (await res.json()) as {
        data?: {
          session?: {
            summary?: string;
            improvementSuggestions?: string[];
            tokenUsage?: { input: number; output: number };
            costUsd?: number;
            metricSummary?: MetricSummary | null;
          };
        };
      };
      const session = body?.data?.session;
      if (session) {
        setCompletionResult({
          summary: session.summary ?? '',
          improvementSuggestions: session.improvementSuggestions ?? [],
          tokenUsage: session.tokenUsage,
          costUsd: session.costUsd,
          metricSummary: session.metricSummary ?? null,
        });
        setCurrentStatus('completed');
      }
    } catch {
      setCompletionError('Failed to complete evaluation. Please try again.');
    } finally {
      setIsCompleting(false);
    }
  }, [evaluation.id]);

  // ─── Re-score (completed sessions only) ────────────────────────────────

  const handleRescore = useCallback(async () => {
    setRescoreError(null);
    setIsRescoring(true);
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.evaluationRescore(evaluation.id), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setRescoreError(body?.error?.message ?? 'Re-score failed. Please try again.');
        return;
      }
      const body = (await res.json()) as {
        data?: { session?: { metricSummary?: MetricSummary } };
      };
      const next = body?.data?.session?.metricSummary;
      if (next) {
        setCompletionResult((prev) => (prev ? { ...prev, metricSummary: next } : prev));
        // Refresh the transcript so per-message score chips pick up the new scores.
        await loadTranscript();
      }
    } catch {
      setRescoreError('Re-score failed. Please try again.');
    } finally {
      setIsRescoring(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluation.id]);

  // ─── Load logs for completed view ──────────────────────────────────────

  const [transcript, setTranscript] = useState<ChatMessage[] | null>(null);
  const [transcriptLoading, setTranscriptLoading] = useState(false);

  useEffect(() => {
    if (evaluation.status !== 'completed') return;
    void loadTranscript();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadTranscript() {
    setTranscriptLoading(true);
    try {
      const res = await fetch(
        `${API.ADMIN.ORCHESTRATION.evaluationLogs(evaluation.id)}?limit=500`,
        { credentials: 'include' }
      );
      if (!res.ok) return;
      const body = (await res.json()) as { data?: { logs?: LogEntry[] } };
      const logs = body?.data?.logs;
      if (logs && logs.length > 0) {
        setTranscript(logsToMessages(logs));
      }
    } catch {
      // Non-critical
    } finally {
      setTranscriptLoading(false);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  // Completed view
  if (isCompleted && completionResult) {
    return (
      <div className="space-y-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="h-6 w-6 shrink-0 text-green-600" />
          <div className="flex-1">
            <h2 className="text-lg font-semibold">Evaluation Complete</h2>
            <p className="text-muted-foreground text-sm">
              {evaluation.agent?.name ?? 'Agent'} · Completed{' '}
              {evaluation.completedAt
                ? new Date(evaluation.completedAt).toLocaleDateString()
                : 'just now'}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={isRescoring}>
                {isRescoring ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-4 w-4" />
                )}
                Re-score
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Re-run metric scoring?</AlertDialogTitle>
                <AlertDialogDescription>
                  Re-runs the judge across every AI response in this session and overwrites the
                  existing scores in place. Useful after a knowledge-base update or prompt change.
                  Running cost will be added to this session&apos;s scoring total.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isRescoring}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleRescore()} disabled={isRescoring}>
                  Re-score
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>

        {rescoreError && (
          <div className="bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
            {rescoreError}
          </div>
        )}

        {/* Metric summary card */}
        {completionResult.metricSummary && (
          <div className="rounded-md border p-4">
            <div className="flex items-center justify-between">
              <h3 className="font-medium">Quality scores</h3>
              <span className="text-muted-foreground text-xs">
                {completionResult.metricSummary.scoredLogCount} response
                {completionResult.metricSummary.scoredLogCount === 1 ? '' : 's'} scored ·{' '}
                {completionResult.metricSummary.judgeModel}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
              <ScoreStat
                label="Faithfulness"
                value={completionResult.metricSummary.avgFaithfulness}
              />
              <ScoreStat
                label="Groundedness"
                value={completionResult.metricSummary.avgGroundedness}
              />
              <ScoreStat label="Relevance" value={completionResult.metricSummary.avgRelevance} />
            </div>
            {completionResult.metricSummary.scoredLogCount < 20 && (
              <p className="text-muted-foreground mt-3 text-xs">
                Per-message scores are noisy below ~20 messages — interpret averages, not individual
                values.
              </p>
            )}
          </div>
        )}

        {/* Summary */}
        <div className="space-y-2">
          <h3 className="font-medium">Summary</h3>
          <div className="bg-muted rounded-md p-4 text-sm whitespace-pre-wrap">
            {completionResult.summary}
          </div>
        </div>

        {/* Suggestions */}
        {completionResult.improvementSuggestions.length > 0 && (
          <div className="space-y-2">
            <h3 className="font-medium">Improvement Suggestions</h3>
            <ul className="list-inside list-disc space-y-1 text-sm">
              {completionResult.improvementSuggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Cost info */}
        {(completionResult.tokenUsage || completionResult.costUsd !== undefined) && (
          <div className="text-muted-foreground text-xs">
            {completionResult.tokenUsage && (
              <span>
                Tokens: {completionResult.tokenUsage.input} in /{' '}
                {completionResult.tokenUsage.output} out
              </span>
            )}
            {completionResult.costUsd !== undefined && (
              <span className="ml-3">Cost: ${completionResult.costUsd.toFixed(4)}</span>
            )}
          </div>
        )}

        {/* Transcript */}
        <div className="space-y-2">
          <h3 className="font-medium">Conversation Transcript</h3>
          {transcriptLoading && (
            <p className="text-muted-foreground text-sm">Loading transcript…</p>
          )}
          {transcript && transcript.length > 0 ? (
            <div className="max-h-96 space-y-2 overflow-y-auto rounded-md border p-3">
              {transcript.map((msg, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex flex-col gap-1.5',
                    msg.role === 'user' ? 'items-end' : 'items-start'
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                      msg.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-muted'
                    )}
                  >
                    {msg.content}
                  </div>
                  {msg.role === 'assistant' && msg.scores && (
                    <EvaluationMetricChips
                      faithfulnessScore={msg.scores.faithfulness}
                      groundednessScore={msg.scores.groundedness}
                      relevanceScore={msg.scores.relevance}
                      reasoning={
                        msg.scores.reasoning
                          ? {
                              faithfulness: msg.scores.reasoning.faithfulness?.reasoning,
                              groundedness: msg.scores.reasoning.groundedness?.reasoning,
                              relevance: msg.scores.reasoning.relevance?.reasoning,
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            !transcriptLoading && (
              <p className="text-muted-foreground text-sm">No transcript available.</p>
            )
          )}
        </div>
      </div>
    );
  }

  // Archived view
  if (isArchived) {
    return (
      <div className="bg-muted/50 rounded-md px-4 py-8 text-center text-sm">
        <Archive className="text-muted-foreground mx-auto mb-2 h-6 w-6" />
        <p className="text-muted-foreground">This evaluation has been archived.</p>
      </div>
    );
  }

  // No agent — can't run chat
  if (!agentSlug) {
    return (
      <div className="bg-destructive/5 text-destructive rounded-md px-4 py-8 text-center text-sm">
        <AlertCircle className="mx-auto mb-2 h-6 w-6" />
        <p>The agent for this evaluation has been deleted. Cannot run the evaluation.</p>
      </div>
    );
  }

  // Active evaluation view
  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex items-center justify-end gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={isArchiving}>
              <Archive className="mr-2 h-4 w-4" />
              Archive
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Archive evaluation?</AlertDialogTitle>
              <AlertDialogDescription>
                Archiving hides this evaluation from the default list view. You can still find it
                using the &ldquo;Archived&rdquo; status filter.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void handleArchive()}>Archive</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Left: Chat */}
        <div className="flex flex-col rounded-md border">
          <div className="border-b px-4 py-2">
            <h3 className="text-sm font-medium">Chat with {evaluation.agent?.name ?? 'Agent'}</h3>
            <Badge variant="secondary" className="mt-1 text-xs">
              {formatStatus(currentStatus)}
            </Badge>
          </div>

          {/* Messages */}
          <div
            className="flex-1 space-y-3 overflow-y-auto p-3"
            style={{ minHeight: 400, maxHeight: 600 }}
          >
            {logsLoading && (
              <p className="text-muted-foreground py-4 text-center text-sm">
                <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                Loading conversation history…
              </p>
            )}
            {!logsLoading && messages.length === 0 && (
              <p className="text-muted-foreground py-12 text-center text-sm">
                Start a conversation to begin your evaluation.
              </p>
            )}
            {messages.map((msg, i) => {
              const isStreamingTail =
                streaming && msg.role === 'assistant' && i === messages.length - 1 && !!msg.content;
              const isStreamingEmpty =
                streaming && msg.role === 'assistant' && !msg.content && i === messages.length - 1;
              return (
                <div key={i} className="flex font-mono text-sm leading-relaxed">
                  <span
                    className="text-muted-foreground shrink-0 pr-2 select-none"
                    aria-hidden="true"
                  >
                    {msg.role === 'user' ? '❯' : ' '}
                  </span>
                  <div className="min-w-0 flex-1 whitespace-pre-wrap">
                    {isStreamingEmpty ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-label="Streaming" />
                    ) : (
                      <>
                        {msg.content}
                        {isStreamingTail && (
                          <span className="terminal-caret text-foreground" aria-hidden="true">
                            █
                          </span>
                        )}
                      </>
                    )}
                    {msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0 && (
                      <MessageTrace toolCalls={msg.toolCalls} />
                    )}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
          </div>

          {/* Chat error */}
          {chatError && <div className="text-destructive px-3 py-1 text-sm">{chatError}</div>}

          {/* Input */}
          <form onSubmit={handleChatSubmit} className="flex gap-2 border-t p-3">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message…"
              disabled={streaming}
            />
            <Button type="submit" size="icon" disabled={streaming || !input.trim()}>
              {streaming ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </form>
        </div>

        {/* Right: Annotations */}
        <div className="flex flex-col rounded-md border">
          <div className="flex items-center justify-between border-b px-4 py-2">
            <div>
              <h3 className="text-sm font-medium">Annotations</h3>
              <p className="text-muted-foreground text-xs">
                Rate and annotate each message in the conversation.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleManualSave}
              disabled={saving}
              title="Save annotations"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            </Button>
          </div>

          {/* Annotation limit warning */}
          {showLimitWarning && (
            <div className="bg-yellow-50 px-4 py-2 text-xs text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
              {remainingSlots} annotation slot{remainingSlots !== 1 ? 's' : ''} remaining (max{' '}
              {MAX_ANNOTATIONS}).
            </div>
          )}
          {atLimit && (
            <div className="bg-destructive/5 text-destructive px-4 py-2 text-xs">
              Annotation limit reached. Remove existing annotations to add new ones.
            </div>
          )}

          <div
            className="flex-1 space-y-1 overflow-y-auto p-3"
            style={{ minHeight: 400, maxHeight: 600 }}
          >
            {messages.length === 0 && (
              <p className="text-muted-foreground py-12 text-center text-sm">
                Messages will appear here as you chat.
              </p>
            )}
            {messages.map((msg, i) => {
              const ann = annotations.get(i);
              const isExpanded = expandedMsg === i;

              return (
                <div key={i} className="rounded-md border p-2">
                  {/* Message preview */}
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 text-left text-sm"
                    onClick={() => setExpandedMsg(isExpanded ? null : i)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-3 w-3 shrink-0" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0" />
                    )}
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {msg.role === 'user' ? 'You' : 'Agent'}
                    </Badge>
                    <span className="truncate">{msg.content.slice(0, 80) || '…'}</span>
                    {ann?.category && (
                      <Badge
                        className={cn(
                          'ml-auto shrink-0 text-xs',
                          CATEGORIES.find((c) => c.value === ann.category)?.color
                        )}
                      >
                        {ann.category}
                      </Badge>
                    )}
                  </button>

                  {/* Expanded annotation controls */}
                  {isExpanded && (
                    <div className="mt-3 space-y-3 border-t pt-3">
                      {/* Category */}
                      <div className="space-y-1">
                        <Label className="text-xs">Category</Label>
                        <div className="flex flex-wrap gap-1">
                          {CATEGORIES.map((cat) => (
                            <Button
                              key={cat.value}
                              type="button"
                              variant={ann?.category === cat.value ? 'default' : 'outline'}
                              size="sm"
                              className="h-7 text-xs"
                              aria-pressed={ann?.category === cat.value}
                              onClick={() =>
                                updateAnnotation(i, {
                                  category: ann?.category === cat.value ? null : cat.value,
                                })
                              }
                            >
                              {cat.label}
                            </Button>
                          ))}
                        </div>
                      </div>

                      {/* Rating */}
                      <div className="space-y-1">
                        <Label className="text-xs">Rating: {ann?.rating ?? 3}/5</Label>
                        <Slider
                          min={1}
                          max={5}
                          step={1}
                          value={[ann?.rating ?? 3]}
                          onValueChange={([v]) => updateAnnotation(i, { rating: v })}
                          className="w-full"
                        />
                      </div>

                      {/* Notes */}
                      <div className="space-y-1">
                        <Label className="text-xs">Notes</Label>
                        <Textarea
                          placeholder="Add notes about this response…"
                          rows={2}
                          value={ann?.notes ?? ''}
                          onChange={(e) => updateAnnotation(i, { notes: e.target.value })}
                          className="text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer: save info + complete button */}
          <div className="border-t p-3">
            {lastSaved && (
              <p className="text-muted-foreground mb-2 text-xs">
                Last saved: {lastSaved.toLocaleTimeString()}
              </p>
            )}
            {completionError && (
              <div className="bg-destructive/5 text-destructive mb-2 rounded-md px-3 py-2 text-sm">
                {completionError}
              </div>
            )}

            {/* Complete with confirmation dialog */}
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={isCompleting || messages.length === 0} className="w-full">
                  {isCompleting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Analysing…
                    </>
                  ) : (
                    'Complete Evaluation'
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Complete this evaluation?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will trigger AI analysis of the conversation and mark the evaluation as
                    completed. This action cannot be undone — the evaluation cannot be reopened
                    after completion.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleComplete()}>
                    Complete Evaluation
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <p className="text-muted-foreground mt-1 text-center text-xs">
              Triggers AI analysis of the conversation.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Small "label · score" stat used in the metric summary card. */
function ScoreStat({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs tracking-wide uppercase">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">
        {value === null ? <span className="text-muted-foreground">n/a</span> : value.toFixed(2)}
      </p>
    </div>
  );
}

/** Convert evaluation log entries to chat messages for display. */
function logsToMessages(logs: LogEntry[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const log of logs) {
    if (log.eventType === 'user_input' && log.content) {
      messages.push({ role: 'user', content: log.content });
    } else if (log.eventType === 'ai_response' && log.content) {
      const hasScores =
        log.faithfulnessScore != null ||
        log.groundednessScore != null ||
        log.relevanceScore != null;
      const message: ChatMessage = { role: 'assistant', content: log.content };
      if (hasScores) {
        message.scores = {
          faithfulness: log.faithfulnessScore ?? null,
          groundedness: log.groundednessScore ?? null,
          relevance: log.relevanceScore ?? null,
          reasoning: log.judgeReasoning ?? undefined,
        };
      }
      messages.push(message);
    }
  }
  return messages;
}

/** Count annotations that have non-default values (would be serialized). */
function countActiveAnnotations(annotations: Map<number, Annotation>): number {
  let count = 0;
  annotations.forEach((ann) => {
    if (ann.category || ann.rating !== 3 || ann.notes) count++;
  });
  return count;
}
