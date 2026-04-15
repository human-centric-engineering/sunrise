/**
 * Pure-TS mappers between the stored `WorkflowDefinition` DAG JSON and
 * the React Flow `nodes` / `edges` arrays the canvas consumes.
 *
 * These functions are intentionally free of React / React Flow imports
 * so they can be unit-tested without DOM or library setup.
 *
 * Layout persistence: x/y positions are stashed in `step.config._layout`.
 * The leading underscore signals "internal/UI metadata" — the validator
 * ignores unknown config keys, so this is schema-safe.
 */

import type { Edge, Node, XYPosition } from '@xyflow/react';

import type {
  ConditionalEdge,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepType,
} from '@/types/orchestration';

/** Data payload stored on each React Flow node used by the builder. */
export interface PatternNodeData extends Record<string, unknown> {
  label: string;
  type: WorkflowStepType;
  config: Record<string, unknown>;
  /**
   * Transient UI flag set by the live validator. Never persisted —
   * `flowToWorkflowDefinition` strips it before serialising.
   */
  hasError?: boolean;
}

export type PatternNode = Node<PatternNodeData, 'pattern'>;

const NODE_TYPE = 'pattern' as const;
const LAYOUT_KEY = '_layout';
const AUTO_LAYOUT_X_STEP = 220;
const AUTO_LAYOUT_Y_STEP = 150;
/** Alternate vertical offset per level to create a zigzag effect. */
const AUTO_LAYOUT_Y_STAGGER = 40;

interface StoredLayout {
  x: number;
  y: number;
}

/**
 * Read the persisted layout from a step's config, or return null if it
 * wasn't saved (first-time open).
 */
function readLayout(config: Record<string, unknown>): StoredLayout | null {
  const raw = config[LAYOUT_KEY];
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const x = obj.x;
  const y = obj.y;
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  return { x, y };
}

/**
 * Strip the internal `_layout` key from a config object so we don't
 * leak UI metadata into the round-trip before re-writing a fresh one.
 */
function stripLayout(config: Record<string, unknown>): Record<string, unknown> {
  if (!(LAYOUT_KEY in config)) return config;
  const copy = { ...config };
  delete copy[LAYOUT_KEY];
  return copy;
}

/**
 * Simple BFS level assignment — nodes at level N are placed at
 * `x = N * 260`, stacked vertically by visit order.
 *
 * Used when a step has no persisted layout. Unreachable steps get a
 * trailing column of their own.
 */
function autoLayout(definition: WorkflowDefinition): Map<string, XYPosition> {
  const positions = new Map<string, XYPosition>();
  if (definition.steps.length === 0) return positions;

  const byId = new Map(definition.steps.map((s) => [s.id, s]));
  const levels = new Map<string, number>();
  const queue: string[] = [];

  if (byId.has(definition.entryStepId)) {
    levels.set(definition.entryStepId, 0);
    queue.push(definition.entryStepId);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const level = levels.get(id) ?? 0;
    const step = byId.get(id);
    if (!step) continue;
    for (const edge of step.nextSteps) {
      if (!byId.has(edge.targetStepId)) continue;
      if (levels.has(edge.targetStepId)) continue;
      levels.set(edge.targetStepId, level + 1);
      queue.push(edge.targetStepId);
    }
  }

  // Unreachable steps land in the next column after the deepest reachable one.
  const maxLevel = Math.max(0, ...Array.from(levels.values()));
  const orphanLevel = maxLevel + 1;
  for (const step of definition.steps) {
    if (!levels.has(step.id)) {
      levels.set(step.id, orphanLevel);
    }
  }

  // Stack vertically within each level using first-seen order.
  // Odd levels are offset vertically to create a zigzag/staggered effect.
  const indexInLevel = new Map<number, number>();
  for (const step of definition.steps) {
    const level = levels.get(step.id) ?? orphanLevel;
    const idx = indexInLevel.get(level) ?? 0;
    const stagger = level % 2 === 1 ? AUTO_LAYOUT_Y_STAGGER : 0;
    positions.set(step.id, {
      x: level * AUTO_LAYOUT_X_STEP,
      y: idx * AUTO_LAYOUT_Y_STEP + stagger,
    });
    indexInLevel.set(level, idx + 1);
  }

  return positions;
}

/**
 * Convert a stored `WorkflowDefinition` into React Flow nodes + edges.
 * Uses persisted per-step `_layout` if present, otherwise auto-layouts
 * via BFS levelling from the entry step.
 */
export function workflowDefinitionToFlow(definition: WorkflowDefinition): {
  nodes: PatternNode[];
  edges: Edge[];
} {
  const autoPositions = autoLayout(definition);

  const nodes: PatternNode[] = definition.steps.map((step) => {
    const stored = readLayout(step.config);
    const position = stored ?? autoPositions.get(step.id) ?? { x: 0, y: 0 };
    return {
      id: step.id,
      type: NODE_TYPE,
      position,
      data: {
        label: step.name,
        type: step.type,
        config: stripLayout(step.config),
        hasError: false,
      },
    };
  });

  const edges: Edge[] = [];
  for (const step of definition.steps) {
    step.nextSteps.forEach((edge, i) => {
      edges.push({
        id: `${step.id}-${edge.targetStepId}-${i}`,
        source: step.id,
        target: edge.targetStepId,
        label: edge.condition ?? undefined,
        type: 'default',
      });
    });
  }

  return { nodes, edges };
}

/**
 * Convert React Flow nodes + edges back into a `WorkflowDefinition`.
 * Stashes each node's x/y into its step config under `_layout` so the
 * next open restores the layout exactly.
 *
 * `entryStepId` is chosen in priority order:
 *   1. The explicit `entryStepId` argument if it still resolves to a node.
 *   2. The first node with no incoming edge.
 *   3. The first node in the list.
 */
export function flowToWorkflowDefinition(
  nodes: readonly PatternNode[],
  edges: readonly Edge[],
  opts: {
    entryStepId?: string;
    errorStrategy?: WorkflowDefinition['errorStrategy'];
  } = {}
): WorkflowDefinition {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const targetIds = new Set(edges.map((e) => e.target));

  const steps: WorkflowStep[] = nodes.map((node) => {
    const outgoing: ConditionalEdge[] = edges
      .filter((e) => e.source === node.id && nodeIds.has(e.target))
      .map((e) => {
        const condition = typeof e.label === 'string' && e.label.length > 0 ? e.label : undefined;
        return { targetStepId: e.target, ...(condition ? { condition } : {}) };
      });

    const baseConfig = stripLayout(node.data.config ?? {});
    const config: Record<string, unknown> = {
      ...baseConfig,
      [LAYOUT_KEY]: { x: node.position.x, y: node.position.y },
    };

    return {
      id: node.id,
      name: node.data.label,
      type: node.data.type,
      config,
      nextSteps: outgoing,
    };
  });

  let entryStepId = opts.entryStepId;
  if (!entryStepId || !nodeIds.has(entryStepId)) {
    const noIncoming = nodes.find((n) => !targetIds.has(n.id));
    entryStepId = noIncoming?.id ?? nodes[0]?.id ?? '';
  }

  return {
    steps,
    entryStepId,
    errorStrategy: opts.errorStrategy ?? 'fail',
  };
}
