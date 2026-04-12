/**
 * Factory for new pattern nodes dropped onto the canvas.
 *
 * Kept out of the React component so it's straightforward to unit-test
 * (the component is `'use client'` and pulls in React Flow, this file
 * doesn't).
 */

import type { XYPosition } from '@xyflow/react';

import { getStepMetadata } from '@/lib/orchestration/engine/step-registry';
import type { WorkflowStepType } from '@/types/orchestration';

import type { PatternNode } from './workflow-mappers';

/** Build a short random step id. Deterministic length for snapshot tests. */
export function makeStepId(): string {
  return `step_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Create a new pattern node for the given step type at the given canvas
 * position. Returns `null` if the type is unknown — the caller should
 * drop invalid payloads silently.
 *
 * `defaultConfig` is shallow-cloned so later edits to the node's config
 * don't leak back into the registry entry.
 */
export function addNode(type: WorkflowStepType, position: XYPosition): PatternNode | null {
  const meta = getStepMetadata(type);
  if (!meta) return null;

  return {
    id: makeStepId(),
    type: 'pattern',
    position,
    data: {
      label: meta.label,
      type: meta.type,
      config: { ...meta.defaultConfig },
    },
  };
}
