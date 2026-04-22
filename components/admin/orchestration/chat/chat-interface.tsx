'use client';

/**
 * ChatInterface — reusable SSE streaming chat component.
 *
 * Wraps the SSE chat infrastructure (`POST /chat/stream`) into a
 * multi-message chat UI with conversation tracking, starter prompts,
 * and event callbacks. Used by the Learning Hub advisor tab and
 * available for embedding in other admin panels.
 *
 * Streaming contract:
 *   - Uses `fetch` + `ReadableStream.getReader()` (not EventSource)
 *   - Parses standard SSE frames (`event:` + `data:` separated by `\n\n`)
 *   - Reads `delta` field from `content` events (matches server ChatEvent)
 *   - Raw error text is NEVER forwarded to the DOM
 *   - In-flight fetch is aborted via `AbortController` on unmount
 *   - Network failures trigger up to 3 reconnect attempts with exponential
 *     backoff (1 s, 2 s, 4 s). HTTP-level errors (429, 4xx, 5xx) are not
 *     retriable. Matches the pattern in `agent-test-chat.tsx`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { getUserFacingError, type UserFacingError } from '@/lib/orchestration/chat/error-messages';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Network-failure retry ceiling. HTTP errors are never retried. */
const MAX_RECONNECT_ATTEMPTS = 3;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatInterfaceProps {
  /** Agent slug to send to `POST /chat/stream`. */
  agentSlug: string;
  /** Optional context type forwarded in the chat request. */
  contextType?: string;
  /** Optional context ID forwarded in the chat request. */
  contextId?: string;
  /** Starter prompt buttons shown when no messages exist. */
  starterPrompts?: string[];
  /** Additional class names for the outer container. */
  className?: string;
  /** Compact mode for embedding in tabs/panels (no card wrapper). */
  embedded?: boolean;
  /** Fires when a `capability_result` event arrives. */
  onCapabilityResult?: (slug: string, result: unknown) => void;
  /** Fires with the full assistant text when streaming completes. */
  onStreamComplete?: (fullText: string) => void;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ChatInterface({
  agentSlug,
  contextType,
  contextId,
  starterPrompts,
  className,
  embedded = false,
  onCapabilityResult,
  onStreamComplete,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Abort on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || streaming) return;

      setError(null);
      setWarning(null);
      setStatus(null);
      setInput('');

      // Append user message and empty assistant message
      setMessages((prev) => [
        ...prev,
        { role: 'user', content: trimmed },
        { role: 'assistant', content: '' },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let fullText = '';

      for (let attempt = 0; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
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
              contextType,
              contextId,
            }),
          });

          if (!res.ok || !res.body) {
            // HTTP-level errors are not retriable
            if (res.status === 429) {
              setError(getUserFacingError('rate_limited'));
            } else {
              setError(getUserFacingError('stream_error'));
            }
            // Remove the empty assistant message if no content streamed yet
            if (!fullText) {
              setMessages((prev) => prev.slice(0, -1));
            }
            return;
          }

          setWarning(null);
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
                if (typeof cid === 'string') {
                  setConversationId(cid);
                }
              } else if (parsed.type === 'content' && typeof parsed.data.delta === 'string') {
                const delta = parsed.data.delta;
                fullText += delta;
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, content: last.content + delta };
                  }
                  return updated;
                });
              } else if (parsed.type === 'status' && typeof parsed.data.message === 'string') {
                setStatus(parsed.data.message);
              } else if (parsed.type === 'capability_result') {
                const slug = parsed.data.capabilitySlug;
                if (typeof slug === 'string') {
                  onCapabilityResult?.(slug, parsed.data.result);
                }
              } else if (parsed.type === 'warning' && typeof parsed.data.message === 'string') {
                setWarning(parsed.data.message);
              } else if (parsed.type === 'error') {
                const code =
                  typeof parsed.data.code === 'string' ? parsed.data.code : 'internal_error';
                setError(getUserFacingError(code));
                return;
              } else if (parsed.type === 'done') {
                setWarning(null);
                onStreamComplete?.(fullText);
                return;
              }
            }
          }

          // Stream ended without a done/error event — treat as complete
          return;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return;

          // Network failure — attempt reconnect with exponential backoff
          if (attempt < MAX_RECONNECT_ATTEMPTS) {
            const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
            setWarning('Connection interrupted. Reconnecting...');
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            continue;
          }

          setError({
            title: 'Connection Lost',
            message: 'Could not reconnect to the chat stream.',
            action: 'Please try sending your message again.',
          });
          return;
        }
      }
    },
    [
      agentSlug,
      conversationId,
      contextType,
      contextId,
      streaming,
      onCapabilityResult,
      onStreamComplete,
    ]
  );

  // Wrap sendMessage to ensure streaming state is always cleaned up
  const sendMessageWrapped = useCallback(
    async (text: string) => {
      try {
        await sendMessage(text);
      } finally {
        setStreaming(false);
        setStatus(null);
        setWarning(null);
        abortRef.current = null;
      }
    },
    [sendMessage]
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendMessageWrapped(input);
  };

  const showStarters = messages.length === 0 && starterPrompts && starterPrompts.length > 0;

  const content = (
    <div className={cn('flex flex-col', embedded ? 'h-full' : 'h-[500px]', className)}>
      {/* Messages area */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {showStarters && (
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <p className="text-muted-foreground mb-2 text-sm">Try asking:</p>
            <div className="flex flex-wrap justify-center gap-2">
              {starterPrompts.map((prompt) => (
                <Button
                  key={prompt}
                  variant="outline"
                  size="sm"
                  onClick={() => void sendMessageWrapped(prompt)}
                  disabled={streaming}
                >
                  {prompt}
                </Button>
              ))}
            </div>
          </div>
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

      {/* Status line */}
      {status && <div className="text-muted-foreground px-3 py-1 text-xs">{status}</div>}

      {/* Warning (reconnecting) */}
      {warning && (
        <div className="flex items-center gap-2 px-3 py-1 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="space-y-0.5 px-3 py-1 text-sm">
          <p className="text-destructive font-medium">{error.title}</p>
          <p className="text-destructive/80">{error.message}</p>
          {error.action && <p className="text-muted-foreground text-xs">{error.action}</p>}
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex gap-2 border-t p-3">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          disabled={streaming}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendMessageWrapped(input);
            }
          }}
        />
        <Button type="submit" size="sm" disabled={streaming || !input.trim()}>
          {streaming ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Send className="h-4 w-4" aria-hidden="true" />
          )}
          <span className="sr-only">Send</span>
        </Button>
      </form>
    </div>
  );

  if (embedded) {
    return content;
  }

  return <div className="rounded-lg border">{content}</div>;
}
