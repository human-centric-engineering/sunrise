'use client';

/**
 * EvaluationRunner (Phase 7 Session 7.1)
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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Loader2, Send } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import {
  type Annotation,
  CATEGORIES,
  serializeAnnotations,
  deserializeAnnotations,
} from '@/lib/orchestration/evaluations/annotation-serializer';

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
}

export interface EvaluationRunnerProps {
  evaluation: EvaluationSession;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface CompletionResult {
  summary: string;
  improvementSuggestions: string[];
  tokenUsage?: { input: number; output: number };
  costUsd?: number;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function EvaluationRunner({ evaluation }: EvaluationRunnerProps) {
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

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

  // Completion state
  const [isCompleting, setIsCompleting] = useState(false);
  const [completionResult, setCompletionResult] = useState<CompletionResult | null>(
    evaluation.status === 'completed' && evaluation.summary
      ? {
          summary: evaluation.summary,
          improvementSuggestions: evaluation.improvementSuggestions ?? [],
        }
      : null
  );
  const [completionError, setCompletionError] = useState<string | null>(null);

  // Status
  const [currentStatus, setCurrentStatus] = useState(evaluation.status);

  // Refs
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const statusPatched = useRef(false);

  const isCompleted = currentStatus === 'completed';
  const agentSlug = evaluation.agent?.slug;

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
      body: JSON.stringify({ status: 'in_progress' }),
    }).then((res) => {
      if (res.ok) setCurrentStatus('in_progress');
    });
  }, [evaluation.id, evaluation.status]);

  // ─── Chat ───────────────────────────────────────────────────────────────

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming || !agentSlug) return;

      setChatError(null);
      setInput('');
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
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: last.content + delta };
                }
                return updated;
              });
            } else if (parsed.type === 'error') {
              setChatError('The agent ran into a problem. Check the server logs for details.');
              return;
            } else if (parsed.type === 'done') {
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
    [agentSlug, conversationId, streaming, evaluation.id]
  );

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  // ─── Annotations ────────────────────────────────────────────────────────

  const updateAnnotation = useCallback(
    (msgIdx: number, update: Partial<Annotation>) => {
      setAnnotations((prev) => {
        const next = new Map(prev);
        const existing = next.get(msgIdx) ?? { category: null, rating: 3, notes: '' };
        next.set(msgIdx, { ...existing, ...update });
        return next;
      });

      // Debounced auto-save
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        void saveAnnotations();
      }, 30_000);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const saveAnnotations = useCallback(async () => {
    try {
      await fetch(API.ADMIN.ORCHESTRATION.evaluationById(evaluation.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: serializeAnnotations(annotations) }),
      });
    } catch {
      // Silent — auto-save is best-effort
    }
  }, [evaluation.id, annotations]);

  // ─── Complete ───────────────────────────────────────────────────────────

  const handleComplete = useCallback(async () => {
    setIsCompleting(true);
    setCompletionError(null);

    try {
      // Save annotations first
      await fetch(API.ADMIN.ORCHESTRATION.evaluationById(evaluation.id), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: serializeAnnotations(annotations) }),
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
        });
        setCurrentStatus('completed');
      }
    } catch {
      setCompletionError('Failed to complete evaluation. Please try again.');
    } finally {
      setIsCompleting(false);
    }
  }, [evaluation.id, annotations]);

  // ─── Render ─────────────────────────────────────────────────────────────

  // Completed view
  if (isCompleted && completionResult) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-6 w-6 text-green-600" />
          <div>
            <h2 className="text-lg font-semibold">Evaluation Complete</h2>
            <p className="text-muted-foreground text-sm">
              {evaluation.agent?.name ?? 'Agent'} · Completed{' '}
              {evaluation.completedAt
                ? new Date(evaluation.completedAt).toLocaleDateString()
                : 'just now'}
            </p>
          </div>
        </div>

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
          {messages.length === 0 && (
            <p className="text-muted-foreground py-12 text-center text-sm">
              Start a conversation to begin your evaluation.
            </p>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={cn(
                'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground ml-auto'
                  : 'bg-muted mr-auto'
              )}
            >
              {msg.content ||
                (streaming && msg.role === 'assistant' && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-label="Streaming" />
                ))}
            </div>
          ))}
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
        <div className="border-b px-4 py-2">
          <h3 className="text-sm font-medium">Annotations</h3>
          <p className="text-muted-foreground text-xs">
            Rate and annotate each message in the conversation.
          </p>
        </div>

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

        {/* Complete button */}
        <div className="border-t p-3">
          {completionError && (
            <div className="bg-destructive/5 text-destructive mb-2 rounded-md px-3 py-2 text-sm">
              {completionError}
            </div>
          )}
          <Button
            onClick={() => void handleComplete()}
            disabled={isCompleting || messages.length === 0}
            className="w-full"
          >
            {isCompleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Analysing…
              </>
            ) : (
              'Complete Evaluation'
            )}
          </Button>
          <p className="text-muted-foreground mt-1 text-center text-xs">
            Triggers AI analysis of the conversation.
          </p>
        </div>
      </div>
    </div>
  );
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
