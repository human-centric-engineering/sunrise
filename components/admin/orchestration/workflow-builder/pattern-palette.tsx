'use client';

/**
 * PatternPalette — left sidebar of the workflow builder.
 *
 * Data-driven: reads from `STEP_REGISTRY` and groups entries by
 * category. Each block is HTML5-draggable — `onDragStart` sets
 * `application/reactflow` on the dataTransfer, which the canvas'
 * `onDrop` reads back out and validates against the registry before
 * materialising a node.
 *
 * Each block has a short `title` tooltip (the description) and a
 * "Learn more" forward-link to the Pattern Explorer (which may 404
 * until that page lands).
 */

import { useState } from 'react';
import { Info } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  STEP_CATEGORY_COLOURS,
  STEP_CATEGORY_LABELS,
  STEP_CATEGORY_ORDER,
  STEP_REGISTRY,
  type StepCategory,
  type StepRegistryEntry,
} from '@/lib/orchestration/engine/step-registry';
import { cn } from '@/lib/utils';

import { PatternCoverageDialog } from '@/components/admin/orchestration/workflow-builder/pattern-coverage-dialog';
import { PatternLearnMoreDialog } from '@/components/admin/orchestration/workflow-builder/pattern-learn-more-dialog';

/** Short descriptions shown under each category heading in the palette. */
const CATEGORY_HINTS: Record<StepCategory, string> = {
  orchestration: 'AI-driven multi-agent coordination',
  agent: 'LLM calls, tool use, and reasoning steps',
  decision: 'Routing, evaluation, and branching logic',
  input: 'Data sources that feed into the workflow',
  output: 'Final results, notifications, and side-effects',
};

function onDragStart(event: React.DragEvent<HTMLDivElement>, type: string) {
  event.dataTransfer.setData('application/reactflow', type);
  event.dataTransfer.effectAllowed = 'move';
}

function PaletteBlock({
  entry,
  usageCount = 0,
  onLearnMore,
}: {
  entry: StepRegistryEntry;
  usageCount?: number;
  onLearnMore?: (patternNumber: number) => void;
}) {
  const colours = STEP_CATEGORY_COLOURS[entry.category];
  const Icon = entry.icon;
  const inUse = usageCount > 0;

  return (
    <div
      data-testid={`palette-block-${entry.type}`}
      draggable
      onDragStart={(e) => onDragStart(e, entry.type)}
      title={entry.description}
      className={cn(
        'group cursor-grab rounded-md border p-2 transition-shadow hover:shadow-sm active:cursor-grabbing',
        colours.bg,
        colours.border,
        colours.text,
        !inUse && 'opacity-60'
      )}
    >
      <div className="flex items-center gap-2">
        <div className={cn('flex h-7 w-7 items-center justify-center rounded', colours.iconBg)}>
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="flex-1 text-sm font-medium">{entry.label}</div>
        {inUse && (
          <span
            data-testid={`palette-count-${entry.type}`}
            className={cn(
              'flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
              colours.iconBg
            )}
          >
            {usageCount}
          </span>
        )}
      </div>
      <p className="text-muted-foreground mt-1 line-clamp-2 text-[11px]">{entry.description}</p>
      <span className="text-muted-foreground/60 mt-0.5 text-[10px]">{entry.estimatedDuration}</span>
      {entry.patternNumber && onLearnMore && (
        <button
          type="button"
          className="mt-1 inline-block text-[11px] underline opacity-0 transition-opacity group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onLearnMore(entry.patternNumber!);
          }}
        >
          Learn more
        </button>
      )}
    </div>
  );
}

export interface PatternPaletteProps {
  /** Map of step type → count of nodes on the canvas using that type. */
  typeCounts?: Readonly<Record<string, number>>;
}

export function PatternPalette({ typeCounts = {} }: PatternPaletteProps) {
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [learnMorePattern, setLearnMorePattern] = useState<number | null>(null);

  const byCategory: Record<StepCategory, StepRegistryEntry[]> = {
    orchestration: [],
    agent: [],
    decision: [],
    input: [],
    output: [],
  };
  for (const entry of STEP_REGISTRY) {
    byCategory[entry.category].push(entry);
  }

  return (
    <aside
      data-testid="pattern-palette"
      className="bg-background flex h-full w-[240px] shrink-0 flex-col overflow-y-auto border-r p-3"
    >
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Patterns</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setCoverageOpen(true)}
          title="How patterns map to step types"
        >
          <Info className="h-4 w-4" />
        </Button>
      </div>
      <div className="space-y-4">
        {STEP_CATEGORY_ORDER.map((category) => {
          const entries = byCategory[category];
          if (entries.length === 0) return null;
          return (
            <section key={category}>
              <h3 className="text-muted-foreground mb-0.5 text-[11px] font-semibold tracking-wide uppercase">
                {STEP_CATEGORY_LABELS[category]}
              </h3>
              <p className="text-muted-foreground/70 mb-2 text-[10px]">
                {CATEGORY_HINTS[category]}
              </p>
              <div className="space-y-2">
                {entries.map((entry) => (
                  <PaletteBlock
                    key={entry.type}
                    entry={entry}
                    usageCount={typeCounts[entry.type] ?? 0}
                    onLearnMore={setLearnMorePattern}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <p className="text-muted-foreground mt-4 text-[11px] leading-relaxed">
        Drag a pattern onto the canvas to add it to the workflow.
      </p>

      <PatternCoverageDialog open={coverageOpen} onOpenChange={setCoverageOpen} />
      <PatternLearnMoreDialog
        open={learnMorePattern !== null}
        patternNumber={learnMorePattern}
        onOpenChange={(open) => {
          if (!open) setLearnMorePattern(null);
        }}
      />
    </aside>
  );
}
