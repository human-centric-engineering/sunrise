'use client';

/**
 * PatternNode — the single custom React Flow node type used for every
 * pattern step. Visual appearance (icon, colour, handle count) is
 * driven entirely by the step registry, so adding a new pattern is a
 * registry edit — no new component needed.
 *
 * Selected state is rendered via a `ring-2 ring-primary` outline.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { HelpCircle } from 'lucide-react';

import {
  STEP_CATEGORY_COLOURS,
  getStepMetadata,
  getStepOutputs,
} from '@/lib/orchestration/engine/step-registry';
import { cn } from '@/lib/utils';

import type { PatternNode as PatternNodeType } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

export function PatternNode({ data, selected }: NodeProps<PatternNodeType>) {
  const meta = getStepMetadata(data.type);
  const colours = STEP_CATEGORY_COLOURS[meta?.category ?? 'input'];
  const Icon = meta?.icon ?? HelpCircle;

  const inputs = meta?.inputs ?? 1;
  const { outputs, outputLabels } = getStepOutputs(data.type, data.config);
  const hasError = Boolean(data.hasError);

  return (
    <div
      data-testid={`pattern-node-${data.type}`}
      className={cn(
        'flex max-w-[160px] min-w-[140px] flex-col items-center gap-2 rounded-lg border-2 px-3 py-3 shadow-sm transition-shadow',
        colours.bg,
        colours.border,
        colours.text,
        selected && !hasError && 'ring-primary shadow-md ring-2',
        hasError && 'shadow-md ring-2 ring-red-500 dark:ring-red-400'
      )}
    >
      {hasError && <span className="sr-only">Step has validation errors</span>}
      {/* Input handles — stacked on the left side */}
      {Array.from({ length: inputs }).map((_, i) => (
        <Handle
          key={`in-${i}`}
          id={`in-${i}`}
          type="target"
          position={Position.Left}
          style={{
            top: inputs === 1 ? '50%' : `${((i + 1) * 100) / (inputs + 1)}%`,
          }}
          className="!h-2 !w-2 !border-2 !border-current !bg-white dark:!bg-zinc-800"
        />
      ))}

      <div className={cn('flex h-8 w-8 items-center justify-center rounded-md', colours.iconBg)}>
        <Icon className="h-4 w-4" />
      </div>

      <div className="text-center">
        <div className="text-sm leading-tight font-semibold">{data.label}</div>
        <div className="text-muted-foreground font-mono text-[10px] uppercase">{data.type}</div>
      </div>

      {/* Output handles — stacked on the right side */}
      {Array.from({ length: outputs }).map((_, i) => {
        const label = outputLabels?.[i];
        const topPct = outputs === 1 ? '50%' : `${((i + 1) * 100) / (outputs + 1)}%`;
        return (
          <div key={`out-${i}`}>
            <Handle
              id={`out-${i}`}
              type="source"
              position={Position.Right}
              style={{ top: topPct }}
              className="!h-2 !w-2 !border-2 !border-current !bg-white dark:!bg-zinc-800"
            />
            {label && (
              <span
                className="text-muted-foreground pointer-events-none absolute right-2.5 -translate-y-1/2 text-[9px] leading-none"
                style={{ top: topPct }}
              >
                {label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
