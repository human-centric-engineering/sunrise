'use client';

/**
 * MessageTrace — inline admin-only diagnostic strip rendered under an
 * assistant message. Surfaces *why* the response was produced: which
 * capabilities the LLM invoked, with what arguments, and at what
 * latency / outcome.
 *
 * Used by:
 *   - chat-interface.tsx (live admin chat — Learning Lab, agent test
 *     tab, conversation history)
 *   - evaluation-runner.tsx (eval session chat)
 *   - conversation-trace-viewer.tsx (post-hoc replay)
 *
 * The component is deliberately admin-only: it shows raw tool
 * arguments and internal slugs that must never reach consumer
 * surfaces. Render it only inside admin route groups.
 *
 * Citations are NOT rendered here — `MessageWithCitations` already
 * owns the citations panel and prevents double-rendering. This strip
 * is exclusively the tool-call trace.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ToolCallTrace } from '@/types/orchestration';

interface MessageTraceProps {
  toolCalls?: ToolCallTrace[];
  defaultOpen?: boolean;
  className?: string;
}

/**
 * Format a latency value for the summary line. Sub-second values stay
 * in milliseconds for resolution; anything else rounds to one decimal
 * place of seconds so the strip stays compact.
 */
export function formatTraceLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Re-export under the old internal name for backwards compatibility. */
const formatLatency = formatTraceLatency;

/**
 * Quick summary of a trace, used by surfaces that render their own
 * toggle button (e.g. the live chat meta strip) but want the same
 * "N tools · 1.2s · M failed" label as `<MessageTrace>`.
 */
export function summarizeToolCalls(toolCalls: ToolCallTrace[]): {
  count: number;
  totalLatencyMs: number;
  failed: number;
} {
  const totalLatencyMs = toolCalls.reduce((sum, c) => sum + c.latencyMs, 0);
  const failed = toolCalls.filter((c) => !c.success).length;
  return { count: toolCalls.length, totalLatencyMs, failed };
}

function formatArguments(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return typeof json === 'string' ? json : String(value);
  } catch {
    return String(value);
  }
}

export function MessageTrace({ toolCalls, defaultOpen = false, className }: MessageTraceProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (!toolCalls || toolCalls.length === 0) return null;

  const totalLatencyMs = toolCalls.reduce((sum, c) => sum + c.latencyMs, 0);
  const failed = toolCalls.filter((c) => !c.success).length;

  return (
    <aside
      className={cn('border-border/60 mt-2 border-t pt-2', className)}
      data-testid="message-trace"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium"
        aria-expanded={open}
        aria-controls="message-trace-details"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        <span className="tabular-nums">
          {toolCalls.length} tool{toolCalls.length === 1 ? '' : 's'} ·{' '}
          {formatLatency(totalLatencyMs)}
        </span>
        {failed > 0 && (
          <span
            className="ml-1 text-amber-700 dark:text-amber-300"
            title={`${failed} call${failed === 1 ? '' : 's'} failed`}
          >
            · {failed} failed
          </span>
        )}
      </button>

      {open && <ToolCallsList toolCalls={toolCalls} id="message-trace-details" />}
    </aside>
  );
}

/**
 * Just the `<ol>` of tool-call cards — no toggle, no border. Used by
 * surfaces that already own the toggle (e.g. the live chat's unified
 * meta strip) so the list slots in next to other expanded panels.
 */
export function ToolCallsList({
  toolCalls,
  id,
}: {
  toolCalls: ToolCallTrace[];
  id?: string;
}): React.ReactElement {
  return (
    <ol id={id} className="mt-2 space-y-2 text-xs">
      {toolCalls.map((tc, idx) => (
        <li
          key={`${tc.slug}-${idx}`}
          className={cn(
            'border-border/40 bg-muted/40 rounded border p-2',
            !tc.success && 'border-amber-300/60 dark:border-amber-700/60'
          )}
          data-testid="message-trace-call"
        >
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[11px]',
                tc.success
                  ? 'bg-primary/10 text-primary'
                  : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full',
                  tc.success ? 'bg-emerald-500' : 'bg-amber-500'
                )}
              />
              {tc.slug}
            </span>
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {formatLatency(tc.latencyMs)}
            </span>
            {typeof tc.costUsd === 'number' && (
              <span className="text-muted-foreground text-[11px] tabular-nums">
                ${tc.costUsd.toFixed(4)}
              </span>
            )}
            {tc.errorCode && (
              <span className="text-[11px] text-amber-700 dark:text-amber-300">{tc.errorCode}</span>
            )}
          </header>

          <details className="mt-1">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px] tracking-wide uppercase">
              Arguments
            </summary>
            <pre className="bg-background/60 mt-1 max-h-48 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
              {formatArguments(tc.arguments)}
            </pre>
          </details>

          {tc.resultPreview && (
            <details className="mt-1">
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px] tracking-wide uppercase">
                Result
              </summary>
              <pre className="bg-background/60 mt-1 max-h-48 overflow-auto rounded p-2 font-mono text-[11px] whitespace-pre-wrap">
                {tc.resultPreview}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}
