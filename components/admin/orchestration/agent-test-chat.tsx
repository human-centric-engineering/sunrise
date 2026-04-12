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
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { API } from '@/lib/api/endpoints';

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

interface ParsedSseEvent {
  type: string;
  data: Record<string, unknown>;
}

const DEFAULT_INITIAL_MESSAGE = 'Hello! Can you tell me what you help with?';

export function AgentTestChat({
  agentSlug,
  placeholder,
  minHeight = 'min-h-[100px]',
  initialMessage = DEFAULT_INITIAL_MESSAGE,
}: AgentTestChatProps) {
  const [message, setMessage] = useState(initialMessage);
  const [reply, setReply] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!agentSlug) {
      setError('No agent slug — save the agent first.');
      return;
    }
    setError(null);
    setReply('');
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(API.ADMIN.ORCHESTRATION.CHAT_STREAM, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentSlug, message }),
      });

      if (!res.ok || !res.body) {
        setError('Chat stream failed to start. Try again in a moment.');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Parse standard SSE: blocks separated by "\n\n", each block a set of
      // `event:` / `data:` lines.
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
            const chunk = parsed.data.delta;
            setReply((prev) => prev + chunk);
          } else if (parsed.type === 'error') {
            // Never forward raw server error text to the UI — show a friendly
            // fallback. Detailed errors are logged server-side only.
            setError('The agent ran into a problem. Check the server logs for details.');
            return;
          } else if (parsed.type === 'done') {
            return;
          }
        }
      }
    } catch (err) {
      // Swallow abort-on-unmount; show a friendly message for everything else.
      if (err instanceof Error && err.name === 'AbortError') return;
      setError('Could not reach the chat stream. Try again in a moment.');
    } finally {
      setStreaming(false);
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
            {streaming ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                Streaming…
              </>
            ) : (
              'Send'
            )}
          </Button>
        </div>
      </form>

      <div className={`bg-muted/30 ${minHeight} rounded-md border p-3 text-sm whitespace-pre-wrap`}>
        {reply || (
          <span className="text-muted-foreground">Agent reply will appear here as it streams.</span>
        )}
      </div>

      {error && <div className="text-destructive text-sm">{error}</div>}
    </div>
  );
}

function parseSseBlock(block: string): ParsedSseEvent | null {
  const lines = block.split('\n');
  let eventType: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment / keepalive
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
