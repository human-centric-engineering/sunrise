'use client';

/**
 * ReasoningPanel — admin-only, collapsed-by-default view of the model's
 * readable reasoning for one assistant turn: Claude's summarized thinking,
 * or the reasoning deltas an OpenAI-compatible provider streams.
 *
 * Used by:
 *   - chat-interface.tsx (live, fed by the `reasoning` SSE event, which the
 *     server sends only when the request sets `includeTrace`)
 *   - conversation-trace-viewer.tsx (replay, from
 *     `MessageMetadata.reasoningSummary`)
 *
 * Render it only inside admin route groups.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface ReasoningPanelProps {
  /** The reasoning text so far. The panel renders nothing when empty. */
  text: string;
  /** True while the turn is still streaming, so the label says so. */
  streaming?: boolean;
  defaultOpen?: boolean;
  className?: string;
}

export function ReasoningPanel({
  text,
  streaming = false,
  defaultOpen = false,
  className,
}: ReasoningPanelProps): React.ReactElement | null {
  const [open, setOpen] = useState(defaultOpen);
  const trimmed = text.trim();
  if (!trimmed) return null;

  const words = trimmed.split(/\s+/).length;
  const label = streaming ? 'Reasoning…' : `Reasoning · ${words} word${words === 1 ? '' : 's'}`;

  return (
    <div className={cn('mb-1 text-[11px]', className)} data-testid="reasoning-panel">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 font-medium"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        <span>{label}</span>
      </button>
      {open && (
        <div
          className="border-border/60 text-muted-foreground mt-1 max-h-64 overflow-y-auto border-l-2 pl-2 text-xs whitespace-pre-wrap italic"
          data-testid="reasoning-panel-text"
        >
          {text}
        </div>
      )}
    </div>
  );
}
