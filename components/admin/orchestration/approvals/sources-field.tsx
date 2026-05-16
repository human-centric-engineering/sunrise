'use client';

/**
 * Render a {@link ProvenanceItem}[] value as a row of pills.
 *
 * One pill per source. Each pill shows a short `[<kind> · <short ref>]`
 * label colour-coded by source kind so an admin can scan a row of
 * proposed changes and spot "all sources are `training_knowledge`" at a
 * glance — exactly the signal that was hidden when audit changes only
 * carried a free-text `reason`.
 *
 * Hover (or keyboard focus) on a pill pops a small tooltip with the full
 * reference (linkified for URLs), the snippet excerpt, and the optional
 * note. If the value doesn't shape-validate against the provenance
 * schema, falls back to a JSON `<pre>` — invariant: never crash the
 * approval UI on a malformed cell.
 *
 * Used by `review-field.tsx` when `field.display === 'sources'` and by
 * the workflow trace viewer.
 */

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  provenanceItemArraySchema,
  type ProvenanceItem,
  type ProvenanceSource,
} from '@/lib/orchestration/provenance/types';

/** Tailwind pill styling per source kind. Keyed by `ProvenanceItem.source`. */
const SOURCE_STYLES: Record<
  ProvenanceSource,
  { label: string; className: string; description: string }
> = {
  web_search: {
    label: 'web',
    className:
      'border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200',
    description: 'Sourced from a web search result',
  },
  knowledge_base: {
    label: 'kb',
    className:
      'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200',
    description: 'Sourced from the knowledge base',
  },
  prior_step: {
    label: 'step',
    className:
      'border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-700 dark:bg-violet-950/40 dark:text-violet-200',
    description: 'Derived from an upstream step output',
  },
  external_call: {
    label: 'api',
    className:
      'border-cyan-300 bg-cyan-50 text-cyan-900 dark:border-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-200',
    description: 'Sourced from an external HTTP call',
  },
  user_input: {
    label: 'input',
    className:
      'border-slate-300 bg-slate-50 text-slate-900 dark:border-slate-700 dark:bg-slate-950/40 dark:text-slate-200',
    description: 'Sourced from workflow input data',
  },
  training_knowledge: {
    label: 'training',
    className:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200',
    description: "Sourced from the model's training knowledge — verify before acting",
  },
};

const CONFIDENCE_GLYPH: Record<ProvenanceItem['confidence'], string> = {
  high: '●●●',
  medium: '●●○',
  low: '●○○',
};

export interface SourcesFieldProps {
  value: unknown;
  /** Render mode. `inline` (default) is for table cells; `stack` is for the trace viewer panel. */
  layout?: 'inline' | 'stack';
}

export function SourcesField({ value, layout = 'inline' }: SourcesFieldProps) {
  const parsed = provenanceItemArraySchema.safeParse(value);
  if (!parsed.success) {
    // Defensive fallback: a buggy upstream step emitted a malformed
    // `sources` array. Render the raw JSON so the admin can still read it
    // rather than blanking the cell.
    return (
      <pre className="bg-muted/30 max-w-md overflow-auto rounded p-1.5 text-[11px] leading-snug">
        {tryStringify(value)}
      </pre>
    );
  }

  const items = parsed.data;
  if (items.length === 0) {
    return <span className="text-muted-foreground italic">—</span>;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className={layout === 'stack' ? 'flex flex-col items-start gap-1' : 'flex flex-wrap gap-1'}
      >
        {items.map((item, idx) => (
          <SourcePill key={`${item.source}-${idx}`} item={item} />
        ))}
      </div>
    </TooltipProvider>
  );
}

function SourcePill({ item }: { item: ProvenanceItem }) {
  const style = SOURCE_STYLES[item.source];
  const shortRef = shortenReference(item.reference);
  const glyph = CONFIDENCE_GLYPH[item.confidence];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className={`cursor-help gap-1 text-[10px] ${style.className}`}
          aria-label={`${style.description} (${item.confidence} confidence)`}
        >
          <span className="font-medium">{style.label}</span>
          {shortRef ? <span className="opacity-70">· {shortRef}</span> : null}
          <span className="ml-0.5 font-mono text-[9px] opacity-60" aria-hidden>
            {glyph}
          </span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="bg-popover text-popover-foreground max-w-md border p-3">
        <SourceTooltipBody item={item} description={style.description} />
      </TooltipContent>
    </Tooltip>
  );
}

function SourceTooltipBody({ item, description }: { item: ProvenanceItem; description: string }) {
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="font-semibold capitalize">{item.source.replace(/_/g, ' ')}</span>
        <span className="text-muted-foreground text-[10px] tracking-wide uppercase">
          {item.confidence} confidence
        </span>
      </div>
      <p className="text-muted-foreground text-[11px]">{description}</p>
      {item.reference ? (
        <div>
          <div className="text-muted-foreground text-[10px] tracking-wide uppercase">Reference</div>
          <ReferenceLink reference={item.reference} stepId={item.stepId} />
        </div>
      ) : null}
      {item.snippet ? (
        <div>
          <div className="text-muted-foreground text-[10px] tracking-wide uppercase">Snippet</div>
          <blockquote className="border-muted-foreground/30 mt-1 border-l-2 pl-2 italic">
            {item.snippet}
          </blockquote>
        </div>
      ) : null}
      {item.note ? (
        <div>
          <div className="text-muted-foreground text-[10px] tracking-wide uppercase">Note</div>
          <p className="mt-1">{item.note}</p>
        </div>
      ) : null}
    </div>
  );
}

function ReferenceLink({ reference, stepId }: { reference: string; stepId?: string }) {
  const isUrl = /^https?:\/\//i.test(reference);
  if (isUrl) {
    return (
      <a
        href={reference}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-[11px] break-all underline-offset-2 hover:underline"
      >
        {reference}
      </a>
    );
  }
  return (
    <p className="font-mono text-[11px] break-all">
      {stepId ? `${stepId} · ${reference}` : reference}
    </p>
  );
}

function shortenReference(reference: string | undefined): string | null {
  if (!reference) return null;
  // Prefer a host for URLs; otherwise show a head-truncated reference so
  // the pill stays scannable in a dense table.
  try {
    if (/^https?:\/\//i.test(reference)) {
      const url = new URL(reference);
      return url.hostname.replace(/^www\./, '');
    }
  } catch {
    // fall through
  }
  return reference.length > 24 ? `${reference.slice(0, 22)}…` : reference;
}

function tryStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unserializable]';
  }
}
