'use client';

/**
 * AgentTestChat (Phase 4 Session 4.2)
 *
 * Embedded streaming chat consumer used to test an agent end-to-end.
 * Reused by:
 *   - Setup Wizard (`StepTestAgent`) — first run verification
 *   - Agent edit page (`AgentForm` → Tab 5 "Test") — iterative tuning
 *
 * Consumes Sunrise's SSE contract from `POST /chat/stream` via
 * `fetch` + `ReadableStream.getReader()`, parses standard SSE frames
 * (`event:` / `data:` lines separated by blank lines), and renders
 * `content` deltas into a growing assistant reply.
 *
 * Security contract:
 *   - Raw provider / SDK error text is NEVER forwarded to the DOM. An
 *     `error` frame (from `sseResponse` in `lib/api/sse.ts`) is mapped to
 *     a generic fallback message; the real error is logged server-side.
 *   - On unmount the in-flight fetch is aborted via `AbortController`.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { getUserFacingError, type UserFacingError } from '@/lib/orchestration/chat/error-messages';

export interface AgentTestChatProps {
  /** Agent slug to hit via `POST /chat/stream`. Required. */
  agentSlug: string;
  /** Placeholder text in the message textarea. */
  placeholder?: string;
  /** Minimum height of the reply panel. Tailwind class, e.g. `min-h-[120px]`. */
  minHeight?: string;
  /** Initial message shown in the input. */
  initialMessage?: string;
}

const DEFAULT_PLACEHOLDER =
  'Try a question your users would ask, e.g. "Summarise last week\'s tickets"';

/** Minimum time the "Streaming…" state stays visible before showing errors. */
const MIN_THINKING_MS = 1500;

export function AgentTestChat({
  agentSlug,
  placeholder = DEFAULT_PLACEHOLDER,
  minHeight = 'min-h-[100px]',
  initialMessage = '',
}: AgentTestChatProps) {
  const [message, setMessage] = useState(initialMessage);
  const [reply, setReply] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!agentSlug) {
      setError({ title: 'Missing Agent', message: 'No agent slug — save the agent first.' });
      return;
    }
    setError(null);
    setWarning(null);
    setStatus(null);
    setReply('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const streamStartedAt = Date.now();

    const ensureMinThinking = async (): Promise<void> => {
      const elapsed = Date.now() - streamStartedAt;
      if (elapsed < MIN_THINKING_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_THINKING_MS - elapsed));
      }
    };

    // Chat POSTs are not idempotent — retrying would duplicate the message
    // on the server. On network failure, show an error and let the user retry.
    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.CHAT_STREAM, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentSlug, message: message.trim() }),
      });

      if (!res.ok || !res.body) {
        await ensureMinThinking();
        if (res.status === 429) {
          setError(getUserFacingError('rate_limited'));
        } else {
          setError(getUserFacingError('stream_error'));
        }
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

          if (parsed.type === 'content' && typeof parsed.data.delta === 'string') {
            const delta: string = parsed.data.delta;
            setReply((prev) => prev + delta);
          } else if (parsed.type === 'status' && typeof parsed.data.message === 'string') {
            setStatus(parsed.data.message);
          } else if (parsed.type === 'warning' && typeof parsed.data.message === 'string') {
            setWarning(parsed.data.message);
          } else if (parsed.type === 'error') {
            const code = typeof parsed.data.code === 'string' ? parsed.data.code : 'internal_error';
            await ensureMinThinking();
            setError(getUserFacingError(code));
            return;
          } else if (parsed.type === 'done') {
            return;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;

      await ensureMinThinking();
      setError({
        title: 'Connection Lost',
        message: 'The chat stream was interrupted.',
        action: 'Please try sending your message again.',
      });
    } finally {
      setStreaming(false);
      setStatus(null);
      abortRef.current = null;
    }
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          void handleSend(e);
        }}
        className="space-y-2"
      >
        <Label htmlFor="agent-test-chat-input">Your message</Label>
        <Textarea
          id="agent-test-chat-input"
          rows={2}
          value={message}
          placeholder={placeholder}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Enter submits, Shift+Enter inserts a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend(e as unknown as React.FormEvent);
            }
          }}
          disabled={streaming}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={streaming || !message.trim()}>
            {streaming ? 'Streaming…' : 'Send'}
          </Button>
        </div>
      </form>

      {warning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </div>
      )}

      <div
        className={`bg-muted/30 ${minHeight} rounded-md border p-3 text-sm whitespace-pre-wrap`}
        role="log"
        aria-live="polite"
        aria-label="Agent reply"
      >
        {streaming && !reply ? (
          <ThinkingIndicator message={status} />
        ) : reply ? (
          <>
            {reply}
            {streaming && status && (
              <div className="text-muted-foreground mt-1 text-xs italic">{status}</div>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">Agent reply will appear here as it streams.</span>
        )}
      </div>

      {error && (
        <div className="space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm dark:border-red-900 dark:bg-red-950/40">
          <p className="font-medium text-red-800 dark:text-red-200">{error.title}</p>
          <p className="text-red-700 dark:text-red-300">{error.message}</p>
          {error.action && <p className="text-muted-foreground text-xs">{error.action}</p>}
        </div>
      )}
    </div>
  );
}
