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
import { ApprovalCard } from '@/components/admin/orchestration/chat/approval-card';
import { MicButton } from '@/components/admin/orchestration/chat/mic-button';
import { AttachmentPickerButton } from '@/components/admin/orchestration/chat/attachment-picker-button';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { getUserFacingError, type UserFacingError } from '@/lib/orchestration/chat/error-messages';
import { useTypingAnimation } from '@/lib/hooks/use-typing-animation';
import type { ChatAttachment } from '@/lib/orchestration/chat/types';
import type { PendingApproval } from '@/types/orchestration';
import { pendingApprovalSchema } from '@/lib/validations/orchestration';

export interface AgentTestChatProps {
  /** Agent slug to hit via `POST /chat/stream`. Required. */
  agentSlug: string;
  /**
   * Agent id used by the speech-to-text endpoint when `voiceInputEnabled`
   * is true. Optional — voice input is hidden when this is absent (the
   * setup wizard's first-run check passes only `agentSlug` because the
   * agent hasn't been persisted yet).
   */
  agentId?: string;
  /**
   * When true (and `agentId` is present), shows a microphone button that
   * records audio, transcribes it, and inserts the transcript into the
   * message field. Audio is forwarded to the configured speech-to-text
   * provider and discarded after transcription.
   */
  voiceInputEnabled?: boolean;
  /**
   * When true, surfaces an attach-image control. Image attachments are
   * sent on the next chat POST as base64 entries; bytes are not
   * persisted. The chat handler additionally gates on the resolved
   * model carrying the `'vision'` capability.
   */
  imageInputEnabled?: boolean;
  /**
   * When true, surfaces an attach-PDF control alongside images. PDFs
   * require the resolved model to carry the `'documents'` capability —
   * currently only the Claude family.
   */
  documentInputEnabled?: boolean;
  /** Placeholder text in the message textarea. */
  placeholder?: string;
  /** Minimum height of the reply panel. Tailwind class, e.g. `min-h-[120px]`. */
  minHeight?: string;
  /** Initial message shown in the input. */
  initialMessage?: string;
}

const DEFAULT_PLACEHOLDER = 'Type a message…';

/** Minimum time the "Streaming…" state stays visible before showing errors. */
const MIN_THINKING_MS = 1500;

export function AgentTestChat({
  agentSlug,
  agentId,
  voiceInputEnabled = false,
  imageInputEnabled = false,
  documentInputEnabled = false,
  placeholder = DEFAULT_PLACEHOLDER,
  minHeight = 'min-h-[100px]',
  initialMessage = '',
}: AgentTestChatProps) {
  const [message, setMessage] = useState(initialMessage);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [approvalNotice, setApprovalNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsControlRef = useRef<{ clear: () => void } | null>(null);
  const attachmentsEnabled = imageInputEnabled || documentInputEnabled;
  // Tracks the previous `streaming` value so we refocus the textarea
  // only on the true → false transition — not on initial mount, which
  // would steal focus from other elements on the agent test page.
  const wasStreamingRef = useRef(false);
  const typing = useTypingAnimation({ chunkSize: 2 });
  const reply = typing.displayText;

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // Restore focus to the textarea when a turn completes so the user can
  // type the next message without clicking back in. The `disabled`
  // attribute drops focus when streaming begins.
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      inputRef.current?.focus();
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  async function handleSend(event: React.FormEvent) {
    event.preventDefault();
    if (!agentSlug) {
      setError({ title: 'Missing Agent', message: 'No agent slug — save the agent first.' });
      return;
    }
    setError(null);
    setWarning(null);
    setStatus(null);
    setPendingApproval(null);
    setApprovalNotice(null);
    typing.reset();
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
      const requestBody: {
        agentSlug: string;
        message: string;
        attachments?: ChatAttachment[];
      } = { agentSlug, message: message.trim() };
      if (attachments.length > 0) {
        requestBody.attachments = attachments;
      }
      const res = await fetch(API.ADMIN.ORCHESTRATION.CHAT_STREAM, {
        method: 'POST',
        credentials: 'include',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
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
            typing.appendDelta(delta);
          } else if (parsed.type === 'status' && typeof parsed.data.message === 'string') {
            setStatus(parsed.data.message);
          } else if (parsed.type === 'warning' && typeof parsed.data.message === 'string') {
            setWarning(parsed.data.message);
          } else if (parsed.type === 'content_reset') {
            typing.reset();
          } else if (parsed.type === 'approval_required' && parsed.data.pendingApproval) {
            // AgentTestChat is a single-turn surface — there's no
            // message thread to carry the workflow output back into,
            // so the card resolves to a static notice rather than
            // synthesising a follow-up turn. Admins testing an
            // approval-bearing agent should send a fresh message
            // afterwards to see how the agent responds.
            //
            // Validate the SSE payload before trusting it as a typed
            // PendingApproval (CLAUDE.md: "Never use `as` on external
            // data — validate with Zod first"). Drop the event silently
            // on parse failure — the card just won't render, matching
            // how other malformed SSE events are handled in this file.
            const parsedPa = pendingApprovalSchema.safeParse(parsed.data.pendingApproval);
            if (parsedPa.success) {
              const pa: PendingApproval = parsedPa.data;
              setPendingApproval(pa);
            }
          } else if (parsed.type === 'error') {
            const code = typeof parsed.data.code === 'string' ? parsed.data.code : 'internal_error';
            await ensureMinThinking();
            setError(getUserFacingError(code));
            return;
          } else if (parsed.type === 'done') {
            typing.flush();
            // Clear attachments after a successful send so the next
            // turn starts fresh; mic + paperclip remain visible.
            setAttachments([]);
            attachmentsControlRef.current?.clear();
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
      setWarning(null);
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
          ref={inputRef}
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
        <div className="flex items-end justify-between gap-2">
          {attachmentsEnabled ? (
            <AttachmentPickerButton
              disabled={streaming}
              pasteTarget={inputRef}
              controlsRef={attachmentsControlRef}
              onAttachmentsChange={setAttachments}
              onError={(msg) => setError({ title: 'Could not attach file', message: msg })}
            />
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            {voiceInputEnabled && agentId && (
              <MicButton
                agentId={agentId}
                endpoint="/api/v1/admin/orchestration/chat/transcribe"
                disabled={streaming}
                onTranscript={(text) =>
                  setMessage((current) => (current ? `${current.trimEnd()} ${text}` : text))
                }
                onError={(msg) =>
                  setError({
                    title: 'Voice input failed',
                    message: msg,
                  })
                }
              />
            )}
            <Button
              type="submit"
              size="sm"
              disabled={streaming || (!message.trim() && attachments.length === 0)}
            >
              {streaming ? 'Streaming…' : 'Send'}
            </Button>
          </div>
        </div>
      </form>

      {warning && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </div>
      )}

      <div
        className={`${minHeight} rounded-md border p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap`}
        role="log"
        aria-live="polite"
        aria-label="Agent reply"
      >
        {streaming && !reply ? (
          <ThinkingIndicator message={status} />
        ) : reply ? (
          <>
            {reply}
            {streaming && (
              <span className="terminal-caret text-foreground" aria-hidden="true">
                █
              </span>
            )}
            {streaming && status && (
              <div className="text-muted-foreground mt-1 text-xs italic">{status}</div>
            )}
          </>
        ) : !pendingApproval ? (
          <span className="text-muted-foreground">Agent reply will appear here as it streams.</span>
        ) : null}
        {pendingApproval && (
          <ApprovalCard
            pendingApproval={pendingApproval}
            onResolved={(action) => {
              setPendingApproval(null);
              setApprovalNotice(
                action === 'approved'
                  ? 'Workflow approved and completed. Send another message to see how the agent responds.'
                  : 'Workflow rejected. Send another message to see how the agent responds.'
              );
            }}
          />
        )}
        {approvalNotice && (
          <div className="text-muted-foreground mt-2 text-xs">{approvalNotice}</div>
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
