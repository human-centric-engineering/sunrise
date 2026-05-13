'use client';

/**
 * ChatInterface — reusable SSE streaming chat component.
 *
 * Wraps the SSE chat infrastructure (`POST /chat/stream`) into a
 * multi-message chat UI with conversation tracking, starter prompts,
 * typing animation, thinking indicator, and event callbacks.
 *
 * Used by the Learning Hub advisor tab and available for embedding in
 * other admin panels.
 *
 * Streaming contract:
 *   - Uses `fetch` + `ReadableStream.getReader()` (not EventSource)
 *   - Parses standard SSE frames (`event:` + `data:` separated by `\n\n`)
 *   - Reads `delta` field from `content` events (matches server ChatEvent)
 *   - Raw error text is NEVER forwarded to the DOM
 *   - In-flight fetch is aborted via `AbortController` on unmount
 *   - Network failures trigger up to 3 reconnect attempts with exponential
 *     backoff (1 s, 2 s, 4 s). HTTP-level errors (429, 4xx, 5xx) are not
 *     retriable.
 *
 * @see lib/hooks/use-typing-animation.ts
 * @see components/admin/orchestration/chat/thinking-indicator.tsx
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2, Send, Trash2 } from 'lucide-react';

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
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { getUserFacingError, type UserFacingError } from '@/lib/orchestration/chat/error-messages';
import { useTypingAnimation } from '@/lib/hooks/use-typing-animation';
import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';
import { MessageWithCitations } from '@/components/admin/orchestration/chat/message-with-citations';
import type { Citation, PendingApproval } from '@/types/orchestration';
import { ApprovalCard } from '@/components/admin/orchestration/chat/approval-card';
import { MicButton } from '@/components/admin/orchestration/chat/mic-button';
import { AttachmentPickerButton } from '@/components/admin/orchestration/chat/attachment-picker-button';
import { IMAGE_ATTACHMENT_MIME, DOCUMENT_ATTACHMENT_MIME } from '@/lib/hooks/use-attachments';
import type { ChatAttachment } from '@/lib/orchestration/chat/types';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Network-failure retry ceiling. HTTP errors are never retried. */
const MAX_RECONNECT_ATTEMPTS = 3;

/**
 * Minimum time (ms) the thinking indicator stays visible before an error
 * replaces it. Prevents jarring instant-error flashes on fast failures
 * (e.g. 429, validation) and makes the chat feel more considered.
 */
const MIN_THINKING_MS = 1500;

/**
 * How long a persisted conversation survives in localStorage before
 * being treated as stale and discarded. Long enough to span a session
 * of admin work; short enough that stale conversations don't
 * accumulate across browser profiles.
 */
const PERSISTENCE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChatInterfaceProps {
  /** Agent slug to send to `POST /chat/stream`. */
  agentSlug: string;
  /**
   * Agent row id — passed to the transcription endpoint so the
   * audio path can resolve the right `enableVoiceInput` row.
   * Required alongside `voiceInputEnabled` to render the mic button.
   * Optional so callers that don't have the metadata yet still work.
   */
  agentId?: string;
  /**
   * When true (and `agentId` is set), renders a mic button next to
   * the Send action that posts audio to
   * `/api/v1/admin/orchestration/chat/transcribe` and appends the
   * resulting text to the input. Defaults to false so existing
   * callers keep their text-only UX until they opt in.
   */
  voiceInputEnabled?: boolean;
  /**
   * When true (and the resolved chat model carries the `'vision'`
   * capability), renders a paperclip control that accepts image
   * attachments. The picker hooks into the chat POST body as
   * `attachments: [{ name, mediaType, data }]`. Default false so
   * existing callers keep their text-only UX.
   */
  imageInputEnabled?: boolean;
  /**
   * When true (and the resolved chat model carries the `'documents'`
   * capability), the same paperclip control also accepts PDF
   * attachments. Independent of `imageInputEnabled` — either, both,
   * or neither can be on.
   */
  documentInputEnabled?: boolean;
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
  /** Enable token-by-token typing animation. Default: true (terminal feel). */
  enableTypingAnimation?: boolean;
  /** Typing animation speed config (only used when enableTypingAnimation is true). */
  typingAnimationOptions?: { chunkSize?: number; intervalMs?: number };
  /** Show a clear/reset conversation button. Default: false. */
  showClearButton?: boolean;
  /** Fires after conversation is cleared. */
  onConversationCleared?: () => void;
  /**
   * When set, the conversation is persisted to `localStorage` under
   * this key after each turn settles and rehydrated on mount. Useful
   * for chat surfaces (e.g. the agent Test tab) where navigating
   * away and back shouldn't discard recent context.
   *
   * Attachment binaries are never persisted — only message text,
   * role, citations, and an `attachmentCount` chip. `pendingApproval`
   * cards are also stripped because the underlying workflow state
   * lives server-side and may have moved on by the time the user
   * returns.
   *
   * Stored data older than 24 h is discarded on read.
   */
  persistenceKey?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** Source attributions surfaced via the `citations` SSE event. */
  citations?: Citation[];
  /** In-chat approval card payload, set on synthetic assistant messages
   * when a `run_workflow` capability paused on a `human_approval` step. */
  pendingApproval?: PendingApproval;
  /**
   * Number of attachments the user submitted with this turn. Rendered
   * as a small "📎 N file(s)" chip below the bubble so attachment-only
   * sends don't read as an empty message.
   */
  attachmentCount?: number;
}

interface PersistedChatState {
  /** Epoch ms — used to apply the TTL on read. */
  savedAt: number;
  conversationId: string | null;
  messages: ChatMessage[];
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ChatInterface({
  agentSlug,
  agentId,
  voiceInputEnabled = false,
  imageInputEnabled = false,
  documentInputEnabled = false,
  contextType,
  contextId,
  starterPrompts,
  className,
  embedded = false,
  onCapabilityResult,
  onStreamComplete,
  enableTypingAnimation = true,
  typingAnimationOptions = { chunkSize: 2 },
  showClearButton = false,
  onConversationCleared,
  persistenceKey,
}: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<UserFacingError | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentsControlRef = useRef<{ clear: () => void } | null>(null);
  const attachmentsEnabled = imageInputEnabled || documentInputEnabled;

  // Auto-resize the message textarea to fit its content, capped at the
  // max-height set on the element. `useLayoutEffect` runs before paint so
  // the user never sees the textarea flash to scrollHeight then collapse.
  // Reset to 'auto' first so the textarea shrinks back when the user
  // deletes lines; the browser then reports the natural scrollHeight.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);
  // Tracks the previous `streaming` value so we can detect the
  // true → false transition and refocus the input. Restoring focus only
  // on transition (not every render) avoids stealing focus from
  // other elements while a turn is mid-flight.
  const wasStreamingRef = useRef(false);

  // Hydration gate. When `persistenceKey` is set we must wait for the
  // load effect to run before the save effect is allowed to write —
  // otherwise the first render (with empty state) would overwrite the
  // stored conversation before we got the chance to restore it.
  const [hydrated, setHydrated] = useState(!persistenceKey);

  // Restore the persisted conversation on mount / when the key changes.
  // Best-effort: any parse failure, schema mismatch, or stale entry is
  // silently dropped and the chat starts empty.
  useEffect(() => {
    if (!persistenceKey || typeof window === 'undefined') {
      setHydrated(true);
      return;
    }
    try {
      const raw = window.localStorage.getItem(persistenceKey);
      if (!raw) {
        setHydrated(true);
        return;
      }
      const parsed = JSON.parse(raw) as PersistedChatState;
      if (
        parsed &&
        typeof parsed.savedAt === 'number' &&
        Date.now() - parsed.savedAt <= PERSISTENCE_TTL_MS &&
        Array.isArray(parsed.messages) &&
        parsed.messages.length > 0
      ) {
        setMessages(parsed.messages);
        setConversationId(typeof parsed.conversationId === 'string' ? parsed.conversationId : null);
      } else {
        window.localStorage.removeItem(persistenceKey);
      }
    } catch {
      // Corrupt blob or quota-exceeded — drop it and carry on.
      try {
        window.localStorage.removeItem(persistenceKey);
      } catch {
        // ignore
      }
    } finally {
      setHydrated(true);
    }
  }, [persistenceKey]);

  // Persist the conversation after each turn settles. We deliberately
  // skip writes while `streaming` is true: typing-animation deltas
  // would otherwise trigger a write on every tick, and a mid-stream
  // navigation away would leave a half-finished assistant turn in
  // storage. The last write after `done` (or after the user clears)
  // is the canonical snapshot.
  useEffect(() => {
    if (!persistenceKey || !hydrated || typeof window === 'undefined') return;
    if (streaming) return;
    try {
      if (messages.length === 0) {
        window.localStorage.removeItem(persistenceKey);
        return;
      }
      const sanitized = messages.map((m) => {
        // Drop pendingApproval — the workflow state lives server-side
        // and may have been resolved or expired by the time the user
        // returns. Re-rendering a stale card would be misleading.
        const { pendingApproval: _pendingApproval, ...rest } = m;
        return rest;
      });
      const payload: PersistedChatState = {
        savedAt: Date.now(),
        conversationId,
        messages: sanitized,
      };
      window.localStorage.setItem(persistenceKey, JSON.stringify(payload));
    } catch {
      // Quota exceeded or serialisation failure — best-effort only.
    }
  }, [persistenceKey, hydrated, messages, streaming, conversationId]);

  const typing = useTypingAnimation({
    disabled: !enableTypingAnimation,
    ...typingAnimationOptions,
  });

  // Update last assistant message when displayText changes (typing animation).
  //
  // Bail when the buffer is empty AND we're not actively streaming or
  // animating: that combination is the post-mount initial state, and
  // running setMessages there would race the hydration effect's restore
  // and silently wipe a rehydrated assistant turn (the callback always
  // sees the latest committed state, so it observes the restored
  // content as "different from the empty buffer" and overwrites it).
  // Once a turn is in flight the buffer is the source of truth again.
  useEffect(() => {
    if (!enableTypingAnimation) return;
    if (!streaming && !typing.isAnimating && !typing.displayText) return;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      if (last.content === typing.displayText) return prev;
      const updated = [...prev];
      updated[updated.length - 1] = { ...last, content: typing.displayText };
      return updated;
    });
  }, [typing.displayText, typing.isAnimating, streaming, enableTypingAnimation]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Restore focus to the input when a turn completes so the user can
  // type the next message without clicking back in. The `disabled`
  // attribute drops focus when streaming begins, so we refocus on the
  // true → false transition only — not on initial mount, which would
  // steal focus from other elements when the chat is rendered as part
  // of a larger page (e.g. the Learning Hub tabs).
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      inputRef.current?.focus();
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  // Abort on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    async (text: string, attachmentsArg?: ChatAttachment[]) => {
      const trimmed = text.trim();
      const submittedAttachments = attachmentsArg ?? [];
      // Empty turn (no text and no attachments) is a no-op; standard
      // text turns require non-empty text; attachment-only turns are
      // allowed (vision use case: "describe this" with a photo).
      if ((!trimmed && submittedAttachments.length === 0) || streaming) return;

      setError(null);
      setWarning(null);
      setStatus(null);
      setInput('');
      setAttachments([]);
      attachmentsControlRef.current?.clear();
      typing.reset();

      // Append user message and empty assistant message
      setMessages((prev) => [
        ...prev,
        {
          role: 'user',
          content: trimmed,
          ...(submittedAttachments.length > 0
            ? { attachmentCount: submittedAttachments.length }
            : {}),
        },
        { role: 'assistant', content: '' },
      ]);
      setStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;
      let fullText = '';
      const streamStartedAt = Date.now();

      /** Wait until MIN_THINKING_MS has elapsed since stream start. */
      const ensureMinThinking = async (): Promise<void> => {
        const elapsed = Date.now() - streamStartedAt;
        if (elapsed < MIN_THINKING_MS) {
          await new Promise((resolve) => setTimeout(resolve, MIN_THINKING_MS - elapsed));
        }
      };

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
              ...(submittedAttachments.length > 0 ? { attachments: submittedAttachments } : {}),
            }),
          });

          if (!res.ok || !res.body) {
            // HTTP-level errors are not retriable — wait for thinking to feel natural
            await ensureMinThinking();
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
                if (enableTypingAnimation) {
                  typing.appendDelta(delta);
                } else {
                  setMessages((prev) => {
                    const updated = [...prev];
                    const last = updated[updated.length - 1];
                    if (last?.role === 'assistant') {
                      updated[updated.length - 1] = { ...last, content: last.content + delta };
                    }
                    return updated;
                  });
                }
              } else if (parsed.type === 'content_reset') {
                fullText = '';
                typing.reset();
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, content: '' };
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
              } else if (
                parsed.type === 'capability_results' &&
                Array.isArray(parsed.data.results)
              ) {
                for (const r of parsed.data.results as unknown[]) {
                  if (
                    r != null &&
                    typeof r === 'object' &&
                    'capabilitySlug' in r &&
                    typeof (r as Record<string, unknown>).capabilitySlug === 'string'
                  ) {
                    onCapabilityResult?.(
                      (r as Record<string, unknown>).capabilitySlug as string,
                      (r as Record<string, unknown>).result
                    );
                  }
                }
              } else if (parsed.type === 'warning' && typeof parsed.data.message === 'string') {
                setWarning(parsed.data.message);
              } else if (parsed.type === 'citations' && Array.isArray(parsed.data.citations)) {
                const citations = parsed.data.citations as Citation[];
                setMessages((prev) => {
                  const updated = [...prev];
                  const last = updated[updated.length - 1];
                  if (last?.role === 'assistant') {
                    updated[updated.length - 1] = { ...last, citations };
                  }
                  return updated;
                });
              } else if (
                parsed.type === 'approval_required' &&
                parsed.data.pendingApproval &&
                typeof parsed.data.pendingApproval === 'object'
              ) {
                // Append a synthetic assistant message that mounts the
                // ApprovalCard. Mirrors the streaming-handler's persistence
                // shape so reload behaviour stays consistent.
                const pa = parsed.data.pendingApproval as PendingApproval;
                setMessages((prev) => [
                  ...prev,
                  { role: 'assistant', content: '', pendingApproval: pa },
                ]);
              } else if (parsed.type === 'error') {
                const code =
                  typeof parsed.data.code === 'string' ? parsed.data.code : 'internal_error';
                await ensureMinThinking();
                setError(getUserFacingError(code));
                return;
              } else if (parsed.type === 'done') {
                setWarning(null);
                typing.flush();
                onStreamComplete?.(fullText);
                return;
              }
            }
          }

          // Stream ended without a done/error event — treat as complete
          typing.flush();
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

          await ensureMinThinking();
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
      enableTypingAnimation,
      typing,
      onCapabilityResult,
      onStreamComplete,
    ]
  );

  // Wrap sendMessage to ensure streaming state is always cleaned up
  const sendMessageWrapped = useCallback(
    async (text: string, attachmentsArg?: ChatAttachment[]) => {
      try {
        await sendMessage(text, attachmentsArg);
      } finally {
        setStreaming(false);
        setStatus(null);
        setWarning(null);
        abortRef.current = null;
      }
    },
    [sendMessage]
  );

  // Read-only ref so callbacks can poll the latest `streaming` flag
  // without becoming stale via closure capture. Used by the approval
  // card's onResolved handler to defer the synthesised follow-up
  // when another chat turn is mid-flight (otherwise sendMessage()
  // would silently drop the follow-up because of its `if (streaming) return`
  // guard, and the LLM would never get the workflow output).
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const sendFollowupWhenIdle = useCallback(
    (text: string) => {
      const attempt = (): void => {
        if (streamingRef.current) {
          setTimeout(attempt, 500);
          return;
        }
        void sendMessageWrapped(text);
      };
      attempt();
    },
    [sendMessageWrapped]
  );

  const handleClear = useCallback(async () => {
    if (conversationId) {
      try {
        await fetch(API.ADMIN.ORCHESTRATION.conversationById(conversationId), {
          method: 'DELETE',
          credentials: 'include',
        });
      } catch {
        // Best-effort — clear local state regardless
      }
    }
    setMessages([]);
    setConversationId(null);
    setError(null);
    setStatus(null);
    setWarning(null);
    typing.reset();
    onConversationCleared?.();
  }, [conversationId, typing, onConversationCleared]);

  const handleSend = useCallback(
    (e?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      void sendMessageWrapped(input, attachments);
    },
    [sendMessageWrapped, input, attachments]
  );

  const showStarters = messages.length === 0 && starterPrompts && starterPrompts.length > 0;
  const isLastAssistantEmpty = (i: number, msg: ChatMessage) =>
    streaming && msg.role === 'assistant' && !msg.content && i === messages.length - 1;

  const content = (
    <div className={cn('flex flex-col', embedded ? 'h-full' : 'h-[500px]', className)}>
      {/* Messages area */}
      <div className="relative flex-1 space-y-3 overflow-y-auto p-3">
        {/* Clear button */}
        {showClearButton && messages.length > 0 && !streaming && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-2 right-2 z-10 h-7 w-7"
                aria-label="Clear conversation"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will remove all messages. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void handleClear()}>Clear</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

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

        {messages.map((msg, i) => {
          const isStreamingTail =
            streaming && msg.role === 'assistant' && i === messages.length - 1 && !!msg.content;
          return (
            <div key={i} className="flex font-mono text-sm leading-relaxed">
              <span className="text-muted-foreground shrink-0 pr-2 select-none" aria-hidden="true">
                {msg.role === 'user' ? '❯' : ' '}
              </span>
              <div className="min-w-0 flex-1">
                {isLastAssistantEmpty(i, msg) && !msg.pendingApproval ? (
                  <ThinkingIndicator message={status} />
                ) : msg.role === 'assistant' ? (
                  <>
                    {msg.content && (
                      <MessageWithCitations
                        content={msg.content}
                        citations={msg.citations}
                        trailingInline={
                          isStreamingTail ? (
                            <span className="terminal-caret text-foreground" aria-hidden="true">
                              █
                            </span>
                          ) : undefined
                        }
                      />
                    )}
                    {msg.pendingApproval && (
                      <ApprovalCard
                        pendingApproval={msg.pendingApproval}
                        onResolved={(_action, followup) => sendFollowupWhenIdle(followup)}
                      />
                    )}
                    {/* Inline status during streaming — shown below content */}
                    {streaming && msg.content && i === messages.length - 1 && status && (
                      <div className="text-muted-foreground mt-1 text-xs italic">{status}</div>
                    )}
                  </>
                ) : (
                  <div>
                    {msg.content && <span className="whitespace-pre-wrap">{msg.content}</span>}
                    {msg.attachmentCount && msg.attachmentCount > 0 && (
                      <span
                        className={cn(
                          'text-muted-foreground inline-flex items-center gap-1 text-xs',
                          msg.content ? 'ml-2' : ''
                        )}
                      >
                        📎 {msg.attachmentCount} file{msg.attachmentCount === 1 ? '' : 's'} attached
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

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

      {/*
        Input row — intentionally a <div>, not a <form>. ChatInterface
        is sometimes mounted inside another <form> (e.g. the agent
        edit page's Test tab sits inside <AgentForm>'s form), and
        nested forms are invalid HTML. The browser collapses them so a
        type="submit" button in here would submit the outer form,
        refreshing the page and bouncing the user off the tab.
        Handling Enter + Send via explicit handlers makes the
        component robust whether mounted standalone or nested.
      */}
      <div className="flex flex-col gap-2 border-t p-3">
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message..."
            disabled={streaming}
            rows={1}
            // Auto-grows up to ~8 lines (160px). The autosize effect
            // below resets and recomputes height on every value change.
            // `resize-none` hides the manual drag handle so the textarea
            // looks like a single-line input that just happens to grow.
            className="max-h-[160px] min-h-[36px] resize-none py-2 leading-snug"
            onKeyDown={(e) => {
              // Skip Enter-to-send while an IME composition is in
              // progress (Japanese/Chinese input). The composition
              // confirmation also dispatches Enter; treating it as
              // "send" would drop the in-progress glyph.
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                handleSend(e);
              }
            }}
          />
          {voiceInputEnabled && agentId && (
            <MicButton
              agentId={agentId}
              endpoint="/api/v1/admin/orchestration/chat/transcribe"
              disabled={streaming}
              onTranscript={(text) =>
                // Append to whatever the operator has already typed
                // rather than replacing. Trim trailing whitespace so
                // we don't end up with double spaces.
                setInput((current) => (current ? `${current.trimEnd()} ${text}` : text))
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
            type="button"
            size="sm"
            onClick={(e) => handleSend(e)}
            disabled={streaming || (!input.trim() && attachments.length === 0)}
          >
            {streaming ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            <span className="sr-only">Send</span>
          </Button>
        </div>
        {attachmentsEnabled && (
          <AttachmentPickerButton
            acceptMime={[
              ...(imageInputEnabled ? IMAGE_ATTACHMENT_MIME : []),
              ...(documentInputEnabled ? DOCUMENT_ATTACHMENT_MIME : []),
            ]}
            disabled={streaming}
            controlsRef={attachmentsControlRef}
            onAttachmentsChange={setAttachments}
            onError={(msg) => setError({ title: 'Could not attach file', message: msg })}
          />
        )}
      </div>
    </div>
  );

  if (embedded) {
    return content;
  }

  return <div className="rounded-lg border">{content}</div>;
}
