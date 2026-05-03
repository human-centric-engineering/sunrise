'use client';

/**
 * MessageWithCitations — renders an assistant message body with `[N]`
 * markers turned into clickable superscript references, paired with a
 * citations panel below the body.
 *
 * Used by:
 *   - chat-interface.tsx (live admin chat)
 *   - conversation-trace-viewer.tsx (admin trace viewer)
 *
 * The embed widget has its own vanilla-JS port (Phase 4) so it shares
 * no React code with this component.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Citation } from '@/types/orchestration';

interface Props {
  content: string;
  citations?: Citation[];
  /** Optional class names for the outer container. */
  className?: string;
  /**
   * Element rendered inline after the last text token (and before the citations
   * panel). Used to attach a streaming-tail caret to the end of the message
   * text without breaking the inline flow.
   */
  trailingInline?: React.ReactNode;
}

/** Splits on `[N]` markers, retaining the markers as discrete tokens. */
const MARKER_SPLIT = /(\[\d+\])/g;
/** Matches a single `[N]` marker token produced by `MARKER_SPLIT`. */
const MARKER_TOKEN = /^\[(\d+)\]$/;

export function MessageWithCitations({ content, citations, className, trailingInline }: Props) {
  const [showSources, setShowSources] = useState(true);

  // No citations on this turn ⇒ leave `[N]` literals alone. Substituting
  // unconditionally would falsely flag any prose that happens to contain
  // bracketed digits (e.g. "see paragraph [5]") as hallucinated.
  if (!citations || citations.length === 0) {
    return (
      <div className={cn('whitespace-pre-wrap', className)}>
        {content}
        {trailingInline}
      </div>
    );
  }

  const validMarkers = new Set(citations.map((c) => c.marker));
  const tokens = content.split(MARKER_SPLIT);

  return (
    <div className={cn('whitespace-pre-wrap', className)}>
      {tokens.map((token, idx) => {
        const match = token.match(MARKER_TOKEN);
        if (!match) {
          // Plain text segment.
          return <span key={idx}>{token}</span>;
        }
        const n = Number.parseInt(match[1], 10);
        const isValid = validMarkers.has(n);
        return (
          <a
            key={idx}
            href={`#citation-${n}`}
            onClick={(e) => {
              if (!isValid) {
                e.preventDefault();
                return;
              }
              // Reveal panel if collapsed so the target scroll lands on something visible.
              setShowSources(true);
            }}
            className={cn(
              'mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 align-super text-[0.65rem] leading-none font-medium transition-colors',
              isValid
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
              !isValid && 'cursor-help'
            )}
            title={
              isValid
                ? `View source ${n}`
                : `Marker [${n}] has no matching citation — possibly hallucinated`
            }
            aria-label={isValid ? `Citation ${n}` : `Unmatched citation marker ${n}`}
          >
            {n}
          </a>
        );
      })}
      {trailingInline}

      {citations && citations.length > 0 && (
        <CitationsPanel
          citations={citations}
          open={showSources}
          onToggle={() => setShowSources((v) => !v)}
        />
      )}
    </div>
  );
}

interface CitationsPanelProps {
  citations: Citation[];
  open: boolean;
  onToggle: () => void;
}

function CitationsPanel({ citations, open, onToggle }: CitationsPanelProps) {
  return (
    <aside className="border-border/60 mt-3 border-t pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        Sources ({citations.length})
      </button>
      {open && (
        <ol className="mt-2 space-y-2 text-xs">
          {citations.map((c) => (
            <li
              key={c.marker}
              id={`citation-${c.marker}`}
              className="border-border/40 rounded border p-2"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-primary bg-primary/10 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-[0.65rem] leading-none font-medium">
                  {c.marker}
                </span>
                <span className="text-foreground font-medium">
                  {c.documentName ?? c.patternName ?? 'Untitled source'}
                </span>
                {c.section && <span className="text-muted-foreground">· {c.section}</span>}
              </div>
              {c.excerpt && (
                <p className="text-muted-foreground mt-1 leading-snug whitespace-pre-wrap">
                  {c.excerpt}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
