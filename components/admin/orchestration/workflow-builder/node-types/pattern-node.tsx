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

import { STEP_CATEGORY_COLOURS, getStepMetadata } from '@/lib/orchestration/engine/step-registry';
import { cn } from '@/lib/utils';

import type { PatternNode as PatternNodeType } from '../workflow-mappers';

export function PatternNode({ data, selected }: NodeProps<PatternNodeType>) {
  const meta = getStepMetadata(data.type);
  const colours = STEP_CATEGORY_COLOURS[meta?.category ?? 'input'];
  const Icon = meta?.icon ?? HelpCircle;

  const inputs = meta?.inputs ?? 1;
  const outputs = meta?.outputs ?? 1;

  return (
    <div
      data-testid={`pattern-node-${data.type}`}
      className={cn(
        'flex min-w-[180px] items-center gap-3 rounded-lg border-2 px-3 py-2 shadow-sm transition-shadow',
        colours.bg,
        colours.border,
        colours.text,
        selected && 'ring-primary shadow-md ring-2'
      )}
    >
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
          className="!h-2 !w-2 !border-2 !border-current !bg-white"
        />
      ))}

      <div className={cn('flex h-8 w-8 items-center justify-center rounded-md', colours.iconBg)}>
        <Icon className="h-4 w-4" />
      </div>

      <div className="flex-1">
        <div className="text-sm font-semibold">{data.label}</div>
        <div className="text-muted-foreground font-mono text-[10px] uppercase">{data.type}</div>
      </div>

      {/* Output handles — stacked on the right side */}
      {Array.from({ length: outputs }).map((_, i) => (
        <Handle
          key={`out-${i}`}
          id={`out-${i}`}
          type="source"
          position={Position.Right}
          style={{
            top: outputs === 1 ? '50%' : `${((i + 1) * 100) / (outputs + 1)}%`,
          }}
          className="!h-2 !w-2 !border-2 !border-current !bg-white"
        />
      ))}
    </div>
  );
}
