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
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Lightbulb,
  Loader2,
  Send,
  Shuffle,
  Trash2,
  X,
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
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { API } from '@/lib/api/endpoints';
import { parseSseBlock } from '@/lib/api/sse-parser';
import { parseChatStreamEvent } from '@/components/admin/orchestration/chat/chat-events';
import { getUserFacingError, type UserFacingError } from '@/lib/orchestration/chat/error-messages';
import { useTypingAnimation } from '@/lib/hooks/use-typing-animation';
import { ThinkingIndicator } from '@/components/admin/orchestration/chat/thinking-indicator';
import {
  CitationsList,
  MessageWithCitations,
} from '@/components/admin/orchestration/chat/message-with-citations';
import {
  ToolCallsList,
  formatTraceLatency,
  summarizeToolCalls,
} from '@/components/admin/orchestration/chat/message-trace';
import { InputBreakdownPopover } from '@/components/admin/orchestration/chat/input-breakdown-popover';
import type {
  Citation,
  InputBreakdown,
  PendingApproval,
  TokenUsage,
  ToolCallTrace,
} from '@/types/orchestration';
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
  /**
   * When provided, renders a small shuffle icon next to the "Try
   * asking:" heading. Clicking it invokes this callback — the parent
   * owns the prompt pool and is expected to swap `starterPrompts` for
   * a fresh sample. Omit the prop on surfaces whose starters are
   * static (no need to render a button that would do nothing).
   */
  onResampleStarters?: () => void;
  /** Additional class names for the outer container. */
  className?: string;
  /** Compact mode for embedding in tabs/panels (no card wrapper). */
  embedded?: boolean;
  /** Fires when a `capability_result` event arrives. */
  onCapabilityResult?: (slug: string, result: unknown) => void;
  /**
   * Admin-only: when true, the request opts into per-capability trace
   * annotations and the chat renders an inline `<MessageTrace>` strip
   * under each assistant message (tool slug, args, latency, success).
   * Default `false` so consumer use of this component (if any future
   * surface reuses it) keeps the redacted wire shape.
   *
   * Render this only inside admin route groups — the strip exposes
   * raw tool arguments and internal slugs.
   */
  showInlineTrace?: boolean;
  /**
   * Pool of suggestion strings drawn on demand by an in-chat
   * lightbulb button rendered next to the textarea. The button only
   * appears once the conversation has started (`messages.length > 0`)
   * and is hidden while streaming. Clicking it replaces the current
   * input with a random pool entry — the operator can then edit
   * before sending. Independent of `starterPrompts`: starters are the
   * pre-conversation grid; the pool is the mid-conversation pick.
   */
  suggestionPool?: readonly string[];
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
   * Show a "download transcript" button that serializes the current
   * messages to a Markdown file. Default: false. Useful on long-running
   * surfaces (Learn advisor/quiz) where the operator may want to keep a
   * copy of the conversation. Citations and tool-call traces are
   * included; attachment binaries are not.
   */
  showDownloadButton?: boolean;
  /**
   * Filename stem used for the downloaded transcript (no extension).
   * Defaults to the `agentSlug` so each surface gets a distinct name.
   */
  downloadFilename?: string;
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
   * Per-capability dispatch diagnostics accumulated across the turn —
   * populated when the chat surface enables `showInlineTrace`. Drives
   * the `<MessageTrace>` strip rendered under the assistant bubble.
   */
  toolCalls?: ToolCallTrace[];
  /**
   * Number of attachments the user submitted with this turn. Rendered
   * as a small "📎 N file(s)" chip below the bubble so attachment-only
   * sends don't read as an empty message.
   */
  attachmentCount?: number;
  /** Approximate cost of this turn in USD (LLM + capabilities). Admin-only. */
  costUsd?: number;
  /** Token accounting for this turn. Admin-only. */
  tokenUsage?: TokenUsage;
  /** Model id reported on the `done` event. Admin-only. */
  modelUsed?: string;
  /**
   * Per-section input-token breakdown supplied by the server. Powers
   * the "why N input tokens?" popover. Admin-only.
   */
  inputBreakdown?: InputBreakdown;
}

interface PersistedChatState {
  /** Epoch ms — used to apply the TTL on read. */
  savedAt: number;
  conversationId: string | null;
  messages: ChatMessage[];
}

/**
 * Append per-capability traces to the in-flight assistant message at
 * the tail of the message list. No-op when the tail is not an
 * assistant message — this can happen on the first capability_result
 * of a turn before any text has streamed, but the assistant placeholder
 * is always appended at send-time so the guard is a defensive belt.
 */
/**
 * Format a USD cost for the inline admin strip. Sub-cent values keep
 * four decimals so they don't all collapse to "$0.00"; larger amounts
 * fall back to standard two-decimal currency.
 */
function formatCostUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0.0000';
  if (Math.abs(value) < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

interface AssistantMetaStripProps {
  message: ChatMessage;
  /** Which diagnostic panel — if any — is expanded under this message. */
  expanded: 'sources' | 'tools' | null;
  onToggle: (panel: 'sources' | 'tools') => void;
  /** Admin gate — when false the strip stays hidden. */
  showInlineTrace: boolean;
}

/**
 * Single horizontal strip under an assistant message that combines the
 * Sources toggle, the Tools (capabilities) toggle, and the per-turn
 * cost summary. The expanded panel (citations list or tool-call list)
 * renders below the strip when one is selected. Mutually exclusive —
 * opening one collapses the other so the vertical footprint stays
 * compact even on turns that ship both kinds of diagnostics.
 */
function AssistantMetaStrip({
  message,
  expanded,
  onToggle,
  showInlineTrace,
}: AssistantMetaStripProps): React.ReactElement | null {
  const hasCitations = !!message.citations && message.citations.length > 0;
  const hasToolCalls = showInlineTrace && !!message.toolCalls && message.toolCalls.length > 0;
  const hasCost = showInlineTrace && (typeof message.costUsd === 'number' || !!message.tokenUsage);

  // Citations always render their toggle (regardless of `showInlineTrace`)
  // because they exist on consumer turns too. Tools + cost are admin-only.
  if (!hasCitations && !hasToolCalls && !hasCost) return null;

  const toolSummary = hasToolCalls ? summarizeToolCalls(message.toolCalls!) : null;

  return (
    <>
      <div className="border-border/60 mt-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t pt-2 text-[11px] tabular-nums">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {hasCitations && (
            <button
              type="button"
              onClick={() => onToggle('sources')}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium"
              aria-expanded={expanded === 'sources'}
            >
              {expanded === 'sources' ? (
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
              )}
              Sources ({message.citations!.length})
            </button>
          )}
          {hasToolCalls && toolSummary && (
            <button
              type="button"
              onClick={() => onToggle('tools')}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium"
              aria-expanded={expanded === 'tools'}
              aria-controls="message-trace-details"
              data-testid="message-trace"
            >
              {expanded === 'tools' ? (
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
              )}
              <span>
                {toolSummary.count} tool{toolSummary.count === 1 ? '' : 's'} ·{' '}
                {formatTraceLatency(toolSummary.totalLatencyMs)}
              </span>
              {toolSummary.failed > 0 && (
                <span
                  className="text-amber-700 dark:text-amber-300"
                  title={`${toolSummary.failed} call${toolSummary.failed === 1 ? '' : 's'} failed`}
                >
                  · {toolSummary.failed} failed
                </span>
              )}
            </button>
          )}
        </div>

        {hasCost && (
          <div className="text-muted-foreground flex flex-wrap items-baseline gap-x-1">
            {typeof message.costUsd === 'number' && (
              <span title="Approximate cost for this turn">≈ {formatCostUsd(message.costUsd)}</span>
            )}
            {message.tokenUsage && (
              <>
                <span aria-hidden="true">·</span>
                <span className="flex items-baseline gap-1">
                  <span>Toks:</span>
                  {message.inputBreakdown ? (
                    <InputBreakdownPopover
                      breakdown={message.inputBreakdown}
                      reportedInputTokens={message.tokenUsage.inputTokens}
                      compact
                    />
                  ) : (
                    <span title="Input tokens for this turn">
                      {message.tokenUsage.inputTokens.toLocaleString()} input
                    </span>
                  )}
                  <span>, {message.tokenUsage.outputTokens.toLocaleString()} output</span>
                </span>
              </>
            )}
            {message.modelUsed && (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono" title="Model used for this turn">
                  {message.modelUsed}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {expanded === 'sources' && hasCitations && <CitationsList citations={message.citations!} />}
      {expanded === 'tools' && hasToolCalls && (
        <ToolCallsList toolCalls={message.toolCalls!} id="message-trace-details" />
      )}
    </>
  );
}

function appendToolTrace(prev: ChatMessage[], traces: ToolCallTrace[]): ChatMessage[] {
  if (traces.length === 0) return prev;
  const updated = [...prev];
  const last = updated[updated.length - 1];
  if (!last || last.role !== 'assistant') return prev;
  updated[updated.length - 1] = {
    ...last,
    toolCalls: [...(last.toolCalls ?? []), ...traces],
  };
  return updated;
}

/**
 * Serialize the chat messages to a Markdown transcript. Includes
 * citations and tool-call traces (where present) so downloaded
 * transcripts retain the same diagnostic detail the operator saw on
 * screen. Attachment binaries are not embedded — only a count chip.
 */
function serializeTranscript(
  messages: ChatMessage[],
  meta: { agentSlug: string; conversationId: string | null }
): string {
  const lines: string[] = [];
  lines.push(`# Chat transcript — ${meta.agentSlug}`);
  lines.push('');
  lines.push(`- Exported: ${new Date().toISOString()}`);
  if (meta.conversationId) lines.push(`- Conversation ID: ${meta.conversationId}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const speaker = msg.role === 'user' ? 'User' : 'Assistant';
    lines.push(`## ${speaker}`);
    lines.push('');
    if (msg.content) {
      lines.push(msg.content);
      lines.push('');
    }
    if (msg.attachmentCount && msg.attachmentCount > 0) {
      lines.push(`_📎 ${msg.attachmentCount} attachment(s)_`);
      lines.push('');
    }
    if (msg.citations && msg.citations.length > 0) {
      lines.push('**Sources:**');
      for (const c of msg.citations) {
        const name = c.documentName ?? c.documentId;
        const section = c.section ? ` — ${c.section}` : '';
        lines.push(`- [${c.marker}] ${name}${section}`);
      }
      lines.push('');
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      lines.push('**Tool calls:**');
      for (const t of msg.toolCalls) {
        const status = t.success === false ? 'failed' : 'ok';
        const ms = typeof t.latencyMs === 'number' ? ` (${t.latencyMs}ms)` : '';
        lines.push(`- \`${t.slug}\` — ${status}${ms}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
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
  onResampleStarters,
  className,
  embedded = false,
  onCapabilityResult,
  showInlineTrace = false,
  suggestionPool,
  onStreamComplete,
  enableTypingAnimation = true,
  typingAnimationOptions = { chunkSize: 2 },
  showClearButton = false,
  onConversationCleared,
  showDownloadButton = false,
  downloadFilename,
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
  // Mid-conversation "Suggested prompts" disclosure. Default closed so
  // it doesn't compete with the assistant text below; opens on click
  // and stays open until the operator collapses it. Independent of
  // the pre-conversation starter grid.
  const [showSuggestedPrompts, setShowSuggestedPrompts] = useState(false);
  /**
   * Per-message diagnostic-panel state. Each entry is keyed by the
   * message's index in {@link messages} and stores which of the
   * Sources/Tools panels is currently expanded under that message
   * (mutually exclusive — only one at a time so the meta strip stays
   * compact). Reset implicitly on conversation clear since the keys
   * are tied to message indices.
   */
  const [expandedPanels, setExpandedPanels] = useState<Record<number, 'sources' | 'tools' | null>>(
    {}
  );

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
              ...(showInlineTrace ? { includeTrace: true } : {}),
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
                if (showInlineTrace) {
                  // Re-validate through the typed parser so we never hand
                  // unknown server payloads into UI state — the new
                  // `trace` shape only flows when admin clients opted in.
                  const typed = parseChatStreamEvent(block);
                  if (typed?.type === 'capability_result' && typed.trace) {
                    const trace = typed.trace;
                    setMessages((prev) => appendToolTrace(prev, [trace]));
                  }
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
                if (showInlineTrace) {
                  const typed = parseChatStreamEvent(block);
                  if (typed?.type === 'capability_results') {
                    const traces = typed.results
                      .map((entry) => entry.trace)
                      .filter((t): t is ToolCallTrace => t !== undefined);
                    if (traces.length > 0) {
                      setMessages((prev) => appendToolTrace(prev, traces));
                    }
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
                if (showInlineTrace) {
                  const typed = parseChatStreamEvent(block);
                  if (typed?.type === 'done') {
                    const costUsd = typed.costUsd;
                    const tokenUsage = typed.tokenUsage;
                    const modelUsed = typed.model;
                    const inputBreakdown = typed.inputBreakdown;
                    if (
                      typeof costUsd === 'number' ||
                      tokenUsage !== undefined ||
                      typeof modelUsed === 'string' ||
                      inputBreakdown !== undefined
                    ) {
                      setMessages((prev) => {
                        const updated = [...prev];
                        const last = updated[updated.length - 1];
                        if (!last || last.role !== 'assistant') return prev;
                        updated[updated.length - 1] = {
                          ...last,
                          ...(typeof costUsd === 'number' ? { costUsd } : {}),
                          ...(tokenUsage ? { tokenUsage } : {}),
                          ...(typeof modelUsed === 'string' ? { modelUsed } : {}),
                          ...(inputBreakdown ? { inputBreakdown } : {}),
                        };
                        return updated;
                      });
                    }
                  }
                }
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

  const handleDownload = useCallback(() => {
    if (typeof window === 'undefined' || messages.length === 0) return;
    const transcript = serializeTranscript(messages, { agentSlug, conversationId });
    const blob = new Blob([transcript], { type: 'text/markdown;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const stem = downloadFilename ?? agentSlug;
    const date = new Date().toISOString().slice(0, 10);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${stem}-${date}.md`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.URL.revokeObjectURL(url);
  }, [messages, agentSlug, conversationId, downloadFilename]);

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
    <div className={cn('relative flex flex-col', embedded ? 'h-full' : 'h-[500px]', className)}>
      {/* Top-right action cluster — anchored to the outer (non-scrolling)
          container so the buttons stay visible regardless of how far the
          messages area is scrolled. Download saves a transcript copy;
          the trash button resets the entire conversation (destructive,
          keeps the AlertDialog confirm). The in-textarea X button below
          is a separate affordance that clears only the input field. */}
      {messages.length > 0 && !streaming && (showDownloadButton || showClearButton) && (
        <div className="bg-background/80 absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md backdrop-blur-sm">
          {showDownloadButton && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="Download transcript"
              onClick={handleDownload}
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          )}
          {showClearButton && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
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
        </div>
      )}

      {/* Suggested prompts disclosure — appears after the first turn
          so operators can grab a new question without scrolling to
          the input. Mirrors the pre-conversation starter grid (same
          prompts, same shuffle icon) but lives in a collapsible row
          beneath the top action cluster. Hidden while streaming so
          the toggle button doesn't fight the "Cancel" affordances. */}
      {messages.length > 0 && starterPrompts && starterPrompts.length > 0 && !streaming && (
        <div className="border-border/60 border-b px-3 py-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowSuggestedPrompts((v) => !v)}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
              aria-expanded={showSuggestedPrompts}
              aria-controls="suggested-prompts-panel"
            >
              {showSuggestedPrompts ? (
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              ) : (
                <ChevronRight className="h-3 w-3" aria-hidden="true" />
              )}
              Suggested prompts
            </button>
            {onResampleStarters && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground h-6 w-6"
                onClick={() => onResampleStarters()}
                aria-label="Randomise suggestions"
                title="Randomise suggestions"
              >
                <Shuffle className="h-3 w-3" aria-hidden="true" />
              </Button>
            )}
          </div>
          {showSuggestedPrompts && (
            <div
              id="suggested-prompts-panel"
              className="mt-2 flex flex-wrap gap-2"
              data-testid="suggested-prompts-panel"
            >
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
          )}
        </div>
      )}

      {/* Messages area */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {showStarters && (
          <div className="flex flex-col items-center justify-center gap-2 py-8">
            <div className="text-muted-foreground mb-2 flex items-center gap-1 text-sm">
              <span>Try asking:</span>
              {onResampleStarters && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground h-6 w-6"
                  onClick={() => onResampleStarters()}
                  aria-label="Randomise suggestions"
                  title="Randomise suggestions"
                  disabled={streaming}
                >
                  <Shuffle className="h-3.5 w-3.5" aria-hidden="true" />
                </Button>
              )}
            </div>
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
                        panelMode="external"
                        onCitationClick={() =>
                          setExpandedPanels((prev) => ({ ...prev, [i]: 'sources' }))
                        }
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
                    <AssistantMetaStrip
                      message={msg}
                      expanded={expandedPanels[i] ?? null}
                      onToggle={(panel) =>
                        setExpandedPanels((prev) => ({
                          ...prev,
                          [i]: prev[i] === panel ? null : panel,
                        }))
                      }
                      showInlineTrace={showInlineTrace}
                    />
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

      {/* Session cost summary — admin diagnostic strip, sums all assistant turns */}
      {showInlineTrace &&
        (() => {
          let totalCost = 0;
          let totalIn = 0;
          let totalOut = 0;
          let costTurns = 0;
          for (const m of messages) {
            if (m.role !== 'assistant') continue;
            if (typeof m.costUsd === 'number') {
              totalCost += m.costUsd;
              costTurns += 1;
            }
            if (m.tokenUsage) {
              totalIn += m.tokenUsage.inputTokens;
              totalOut += m.tokenUsage.outputTokens;
            }
          }
          if (costTurns === 0 && totalIn === 0 && totalOut === 0) return null;
          return (
            <div className="text-muted-foreground border-border/60 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t px-3 py-1.5 text-[11px] tabular-nums">
              <span className="text-foreground font-medium">Session</span>
              {costTurns > 0 && (
                <span title={`Sum across ${costTurns} turn${costTurns === 1 ? '' : 's'}`}>
                  ≈ {formatCostUsd(totalCost)}
                </span>
              )}
              {(totalIn > 0 || totalOut > 0) && (
                <span title="Total input / output tokens across the session">
                  {totalIn.toLocaleString()} input tokens · {totalOut.toLocaleString()} output
                  tokens
                </span>
              )}
            </div>
          );
        })()}

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
          <div className="relative flex-1">
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
              // `pr-9` reserves room for the in-field clear button so
              // long input doesn't slide under the X icon.
              className="max-h-[160px] min-h-[36px] resize-none py-2 pr-9 leading-snug"
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
            {input.length > 0 && !streaming && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground absolute top-1 right-1 h-7 w-7"
                aria-label="Clear input"
                title="Clear input"
                onClick={() => {
                  setInput('');
                  inputRef.current?.focus();
                }}
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            )}
          </div>
          {suggestionPool && suggestionPool.length > 0 && messages.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-9 w-9 shrink-0"
              aria-label="Suggest a prompt"
              title="Suggest a prompt"
              disabled={streaming}
              onClick={() => {
                // Random pick from the pool. Replaces the current
                // input — the operator clicked this on purpose, and
                // appending would silently grow a long buffer when
                // they hit the button repeatedly.
                const idx = Math.floor(Math.random() * suggestionPool.length);
                const next = suggestionPool[idx];
                if (typeof next === 'string') setInput(next);
                inputRef.current?.focus();
              }}
            >
              <Lightbulb className="h-4 w-4" aria-hidden="true" />
            </Button>
          )}
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
