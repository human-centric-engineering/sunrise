'use client';

/**
 * Three compact F/G/R chips showing the LLM-as-judge metric scores for
 * an `ai_response` evaluation log. Click a chip to see the judge's
 * reasoning. Designed for inline rendering next to chat messages on the
 * evaluation runner page.
 *
 * Score colour scaling:
 *   ≥ 0.85  → green   (good)
 *   ≥ 0.6   → amber   (mixed)
 *   < 0.6   → red     (concerning)
 *   null    → muted "n/a" (only valid for faithfulness when the answer
 *                          carries no inline `[N]` markers)
 *
 * The chips are advisory, not authoritative. The reasoning popover gives
 * admins enough context to judge whether the judge itself was wrong.
 */

import * as React from 'react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface EvaluationMetricChipsProps {
  faithfulnessScore: number | null;
  groundednessScore: number | null;
  relevanceScore: number | null;
  /** Per-metric reasoning text from the judge — display-only. */
  reasoning?: {
    faithfulness?: string;
    groundedness?: string;
    relevance?: string;
  };
  className?: string;
}

interface MetricRowProps {
  letter: 'F' | 'G' | 'R';
  label: string;
  score: number | null;
  reasoning: string | undefined;
}

function scoreColour(score: number | null): string {
  if (score === null) return 'bg-muted text-muted-foreground';
  if (score >= 0.85) return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
  if (score >= 0.6) return 'bg-amber-500/15 text-amber-700 dark:text-amber-300';
  return 'bg-red-500/15 text-red-700 dark:text-red-300';
}

function formatScore(score: number | null): string {
  if (score === null) return 'n/a';
  return score.toFixed(2);
}

function MetricChip({ letter, label, score, reasoning }: MetricRowProps): React.ReactElement {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label} score: ${formatScore(score)}`}
          className={cn(
            'focus-visible:ring-ring inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium tabular-nums transition-colors hover:opacity-80 focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:outline-none',
            scoreColour(score)
          )}
        >
          <span className="font-semibold">{letter}</span>
          <span aria-hidden="true">·</span>
          <span>{formatScore(score)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">{label}</p>
            <span
              className={cn(
                'rounded-md px-2 py-0.5 text-xs font-medium tabular-nums',
                scoreColour(score)
              )}
            >
              {formatScore(score)}
            </span>
          </div>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {reasoning ?? 'No reasoning recorded.'}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function EvaluationMetricChips({
  faithfulnessScore,
  groundednessScore,
  relevanceScore,
  reasoning,
  className,
}: EvaluationMetricChipsProps): React.ReactElement {
  return (
    <div className={cn('flex items-center gap-1', className)}>
      <MetricChip
        letter="F"
        label="Faithfulness"
        score={faithfulnessScore}
        reasoning={reasoning?.faithfulness}
      />
      <MetricChip
        letter="G"
        label="Groundedness"
        score={groundednessScore}
        reasoning={reasoning?.groundedness}
      />
      <MetricChip
        letter="R"
        label="Relevance"
        score={relevanceScore}
        reasoning={reasoning?.relevance}
      />
    </div>
  );
}
