'use client';

/**
 * ExecutionTraceFilters — chip row above the per-step trace list.
 *
 * Six client-side filters: All / Failed / Slow / LLM-only / Tool-only /
 * With approvals. State is local to the parent (ExecutionDetailView)
 * and not persisted to URL — single-tenant deployments don't need
 * deep-linkable filtered traces, and avoiding URL params keeps the
 * surface small.
 */

import * as React from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { slowOutlierThresholdMs } from '@/lib/orchestration/trace/aggregate';
import type { ExecutionTraceEntry } from '@/types/orchestration';

export type TraceFilter = 'all' | 'failed' | 'slow' | 'llm-only' | 'tool-only' | 'with-approvals';

const FILTER_LABEL: Record<TraceFilter, string> = {
  all: 'All',
  failed: 'Failed',
  slow: 'Slow',
  'llm-only': 'LLM only',
  'tool-only': 'Tool only',
  'with-approvals': 'With approvals',
};

export interface ExecutionTraceFiltersProps {
  trace: ExecutionTraceEntry[];
  active: TraceFilter;
  onChange: (filter: TraceFilter) => void;
}

/**
 * Apply a `TraceFilter` to a trace array. Pure — exported for tests and
 * for the parent component to compute the filtered list.
 */
export function applyTraceFilter(
  trace: ExecutionTraceEntry[],
  filter: TraceFilter
): ExecutionTraceEntry[] {
  if (filter === 'all') return trace;
  if (filter === 'failed') {
    return trace.filter((e) => e.status === 'failed' || e.status === 'rejected');
  }
  if (filter === 'with-approvals') {
    return trace.filter((e) => e.status === 'awaiting_approval');
  }
  if (filter === 'slow') {
    const threshold = slowOutlierThresholdMs(trace);
    if (threshold === null) return trace;
    return trace.filter((e) => e.durationMs >= threshold);
  }
  if (filter === 'llm-only') {
    // LLM-bearing steps either have an LLM-attribution field set or are a
    // known LLM step type. The first check catches custom step types that
    // pushed telemetry; the second catches steps that errored before
    // pushing any (so the filter still surfaces them for diagnosis).
    const llmTypes = new Set([
      'llm_call',
      'agent_call',
      'orchestrator',
      'evaluate',
      'reflect',
      'guard',
      'route',
      'plan',
    ]);
    return trace.filter(
      (e) =>
        typeof e.model === 'string' ||
        typeof e.llmDurationMs === 'number' ||
        llmTypes.has(e.stepType)
    );
  }
  if (filter === 'tool-only') {
    return trace.filter((e) => e.stepType === 'tool_call' || e.stepType === 'external_call');
  }
  return trace;
}

export function ExecutionTraceFilters({
  trace,
  active,
  onChange,
}: ExecutionTraceFiltersProps): React.ReactElement | null {
  if (trace.length === 0) return null;

  const counts: Record<TraceFilter, number> = {
    all: trace.length,
    failed: applyTraceFilter(trace, 'failed').length,
    slow: applyTraceFilter(trace, 'slow').length,
    'llm-only': applyTraceFilter(trace, 'llm-only').length,
    'tool-only': applyTraceFilter(trace, 'tool-only').length,
    'with-approvals': applyTraceFilter(trace, 'with-approvals').length,
  };

  const filters: TraceFilter[] = [
    'all',
    'failed',
    'slow',
    'llm-only',
    'tool-only',
    'with-approvals',
  ];

  return (
    <div
      className="flex flex-wrap gap-2"
      role="group"
      aria-label="Trace filters"
      data-testid="execution-trace-filters"
    >
      {filters.map((filter) => {
        const count = counts[filter];
        const disabled = filter !== 'all' && count === 0;
        return (
          <Button
            key={filter}
            type="button"
            size="sm"
            variant={active === filter ? 'default' : 'outline'}
            disabled={disabled}
            onClick={() => onChange(filter)}
            data-testid={`trace-filter-${filter}`}
            data-active={active === filter ? 'true' : 'false'}
            className={cn('h-7 gap-1.5 px-2.5 text-xs')}
          >
            <span>{FILTER_LABEL[filter]}</span>
            <span
              className={cn(
                'rounded px-1 py-0 font-mono text-[10px]',
                active === filter ? 'bg-primary-foreground/20' : 'bg-muted'
              )}
            >
              {count}
            </span>
          </Button>
        );
      })}
    </div>
  );
}
