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

import { Children, cloneElement, isValidElement, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { Citation } from '@/types/orchestration';
// SECURITY: react-markdown is intentionally used with NO plugins. Default
// behaviour treats raw HTML in markdown source as inert text, which is what
// makes it safe to render model-emitted content. Adding `rehype-raw` or
// `allowDangerousHtml` here would turn a `<script>` injected via prompt
// poisoning into an XSS sink.
import Markdown from 'react-markdown';

import { cn } from '@/lib/utils';

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
  /**
   * Where the citations panel lives.
   * - `'inline'` (default): the component renders its own toggle +
   *   expandable list directly under the body. Used by post-hoc
   *   surfaces (conversation trace viewer, evaluation runner) that
   *   want a self-contained bubble.
   * - `'external'`: the component renders only the body with marker
   *   anchors. The caller renders the toggle and list themselves via
   *   {@link CitationsList} — used by the live chat interface so the
   *   sources, tools, and cost summary can share one meta strip.
   */
  panelMode?: 'inline' | 'external';
  /**
   * Called when a valid citation marker is clicked. Only consulted in
   * `'external'` mode — `'inline'` mode opens the internal panel
   * instead. Use this to surface the citations list elsewhere.
   */
  onCitationClick?: () => void;
}

// Private-use unicode sentinels wrap citation markers in the markdown source
// so `[N]` survives markdown parsing intact (markdown otherwise treats
// `[text]` as a candidate link opener). Walking the rendered tree turns the
// sentinel runs back into citation anchors.
const CITE_OPEN = '';
const CITE_CLOSE = '';
const CITE_SOURCE_RE = /\[(\d+)\]/g;
const CITE_SENTINEL_RE = /(\d+)/g;

// Minimal styling for markdown blocks. We intentionally avoid `prose`
// here because the surrounding chat-interface uses `font-mono` and prose
// would override the typography. These selectors only touch margins/
// padding and the code-block backgrounds so block elements look right
// inside compact chat bubbles regardless of the parent font choice.
const MARKDOWN_BLOCK_CLASSES = [
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_ul]:my-2 [&_ul]:pl-5 [&_ul]:list-disc',
  '[&_ol]:my-2 [&_ol]:pl-5 [&_ol]:list-decimal',
  '[&_li]:my-0.5 [&_li>p]:my-0',
  '[&_h1]:my-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:my-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:my-2 [&_h3]:font-semibold',
  '[&_h4]:my-2 [&_h4]:font-semibold',
  '[&_h5]:my-2 [&_h5]:font-semibold',
  '[&_h6]:my-2 [&_h6]:font-semibold',
  '[&_strong]:font-semibold [&_em]:italic',
  '[&_code]:rounded-sm [&_code]:bg-foreground/10 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-[0.9em]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-foreground/5 [&_pre]:p-2',
  '[&_pre>code]:bg-transparent [&_pre>code]:p-0',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:opacity-90',
  '[&_a]:text-primary [&_a]:underline',
].join(' ');

export function MessageWithCitations({
  content,
  citations,
  className,
  trailingInline,
  panelMode = 'inline',
  onCitationClick,
}: Props): React.ReactElement {
  // Default closed so the sources list doesn't dominate the message
  // body — operators can expand it on demand. The marker anchors
  // (`[N]`) still re-open the panel when clicked so jumping to a
  // citation works the same as before.
  const [showSources, setShowSources] = useState(false);
  const hasCitations = !!citations && citations.length > 0;

  // No citations on this turn ⇒ leave `[N]` literals alone. Substituting
  // unconditionally would falsely flag any prose that happens to contain
  // bracketed digits (e.g. "see paragraph [5]") as hallucinated.
  const validMarkers = hasCitations ? new Set(citations.map((c) => c.marker)) : null;
  const encoded = hasCitations
    ? content.replace(CITE_SOURCE_RE, (_, n) => `${CITE_OPEN}${n}${CITE_CLOSE}`)
    : content;

  const handleMarkerClick =
    panelMode === 'external' ? () => onCitationClick?.() : () => setShowSources(true);

  const transform = (node: ReactNode): ReactNode => {
    if (!validMarkers) return node;
    return walkChildren(node, (text) => splitCitations(text, validMarkers, handleMarkerClick));
  };

  return (
    <>
      <div className={cn(MARKDOWN_BLOCK_CLASSES, className)}>
        <Markdown
          components={{
            p: ({ children, ...props }) => <p {...props}>{transform(children)}</p>,
            li: ({ children, ...props }) => <li {...props}>{transform(children)}</li>,
            h1: ({ children, ...props }) => <h1 {...props}>{transform(children)}</h1>,
            h2: ({ children, ...props }) => <h2 {...props}>{transform(children)}</h2>,
            h3: ({ children, ...props }) => <h3 {...props}>{transform(children)}</h3>,
            h4: ({ children, ...props }) => <h4 {...props}>{transform(children)}</h4>,
            h5: ({ children, ...props }) => <h5 {...props}>{transform(children)}</h5>,
            h6: ({ children, ...props }) => <h6 {...props}>{transform(children)}</h6>,
            blockquote: ({ children, ...props }) => (
              <blockquote {...props}>{transform(children)}</blockquote>
            ),
            td: ({ children, ...props }) => <td {...props}>{transform(children)}</td>,
            th: ({ children, ...props }) => <th {...props}>{transform(children)}</th>,
          }}
        >
          {encoded}
        </Markdown>
        {trailingInline}
      </div>

      {hasCitations && panelMode === 'inline' && (
        <CitationsPanel
          citations={citations}
          open={showSources}
          onToggle={() => setShowSources((v) => !v)}
        />
      )}
    </>
  );
}

/**
 * Just the `<ol>` of citations — no toggle, no border. Used by surfaces
 * that already own the toggle (e.g. the live chat's unified meta strip)
 * so the list slots in next to other expanded panels.
 */
export function CitationsList({ citations }: { citations: Citation[] }): React.ReactElement {
  return (
    <ol className="mt-2 space-y-2 text-xs">
      {citations.map((c) => (
        <li
          key={c.marker}
          id={`citation-${c.marker}`}
          className="border-border/40 bg-muted/40 rounded border p-2"
        >
          <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-primary bg-primary/10 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 text-[11px] leading-none font-medium">
              {c.marker}
            </span>
            <span className="text-foreground text-[11px] font-medium">
              {c.documentName ?? c.patternName ?? 'Untitled source'}
            </span>
            {c.section && <span className="text-muted-foreground text-[11px]">· {c.section}</span>}
          </header>
          {c.excerpt && (
            <div
              className={cn(
                MARKDOWN_BLOCK_CLASSES,
                'text-muted-foreground mt-1 text-[11px] leading-snug'
              )}
            >
              <Markdown>{c.excerpt}</Markdown>
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Recursively walks React children, applying `transform` to every text
 * (string) leaf. Non-string leaves and elements without children pass
 * through unchanged. Element children get cloned with their transformed
 * sub-tree so nested formatting (strong/em/code inside paragraphs) keeps
 * working.
 */
function walkChildren(children: ReactNode, transform: (text: string) => ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') return transform(child);
    if (!isValidElement(child)) return child;
    const props = child.props as { children?: ReactNode };
    if (props.children === undefined) return child;
    return cloneElement(child, undefined, walkChildren(props.children, transform));
  });
}

/**
 * Splits a text run on sentinel-wrapped citation markers and emits
 * superscript anchors for each. Markers whose `N` has no matching
 * citation render in the "hallucinated" amber style.
 */
function splitCitations(
  text: string,
  validMarkers: Set<number>,
  onValidClick: () => void
): ReactNode {
  if (!text.includes(CITE_OPEN)) return text;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  CITE_SENTINEL_RE.lastIndex = 0;
  while ((match = CITE_SENTINEL_RE.exec(text))) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const n = Number.parseInt(match[1], 10);
    const isValid = validMarkers.has(n);
    parts.push(
      <a
        key={`cite-${match.index}-${n}`}
        href={`#citation-${n}`}
        onClick={(e) => {
          if (!isValid) {
            e.preventDefault();
            return;
          }
          onValidClick();
        }}
        className={cn(
          'mx-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 align-super text-[0.65rem] leading-none font-medium no-underline transition-colors',
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
    lastIndex = CITE_SENTINEL_RE.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

interface CitationsPanelProps {
  citations: Citation[];
  open: boolean;
  onToggle: () => void;
}

function CitationsPanel({ citations, open, onToggle }: CitationsPanelProps): React.ReactElement {
  return (
    <aside className="border-border/60 mt-2 border-t pt-2">
      <button
        type="button"
        onClick={onToggle}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px] font-medium"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden="true" />
        )}
        Sources ({citations.length})
      </button>
      {open && <CitationsList citations={citations} />}
    </aside>
  );
}
