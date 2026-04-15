/**
 * Unit Tests: workflow-mappers
 *
 * Test Coverage:
 * - workflowDefinitionToFlow: empty definition produces empty nodes/edges
 * - workflowDefinitionToFlow: 3-step linear chain produces correct nodes and edges
 * - workflowDefinitionToFlow: route step with conditional edges
 * - workflowDefinitionToFlow: stored _layout is honoured
 * - workflowDefinitionToFlow: missing _layout produces BFS auto-layout
 * - flowToWorkflowDefinition: round-trip preserves step ids, names, types, configs
 * - flowToWorkflowDefinition: writes _layout into every step config
 * - flowToWorkflowDefinition: entryStepId defaults to first node with no incoming edge
 * - flowToWorkflowDefinition: strips pre-existing _layout before re-writing
 *
 * @see components/admin/orchestration/workflow-builder/workflow-mappers.ts
 */

import { describe, it, expect } from 'vitest';

import {
  workflowDefinitionToFlow,
  flowToWorkflowDefinition,
  type PatternNode,
} from '@/components/admin/orchestration/workflow-builder/workflow-mappers';
import type { WorkflowDefinition } from '@/types/orchestration';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMPTY_DEFINITION: WorkflowDefinition = {
  steps: [],
  entryStepId: '',
  errorStrategy: 'fail',
};

const LINEAR_3_DEFINITION: WorkflowDefinition = {
  entryStepId: 'step-a',
  errorStrategy: 'fail',
  steps: [
    {
      id: 'step-a',
      name: 'Step A',
      type: 'llm_call',
      config: {},
      nextSteps: [{ targetStepId: 'step-b' }],
    },
    {
      id: 'step-b',
      name: 'Step B',
      type: 'chain',
      config: {},
      nextSteps: [{ targetStepId: 'step-c' }],
    },
    { id: 'step-c', name: 'Step C', type: 'reflect', config: {}, nextSteps: [] },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('workflowDefinitionToFlow', () => {
  it('returns empty nodes and edges for an empty definition', () => {
    const { nodes, edges } = workflowDefinitionToFlow(EMPTY_DEFINITION);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('converts a 3-step linear chain to 3 nodes and 2 edges', () => {
    const { nodes, edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    expect(nodes).toHaveLength(3);
    expect(edges).toHaveLength(2);

    // Verify node ids match step ids
    const nodeIds = nodes.map((n) => n.id);
    expect(nodeIds).toContain('step-a');
    expect(nodeIds).toContain('step-b');
    expect(nodeIds).toContain('step-c');
  });

  it('edges have correct source and target for linear chain', () => {
    const { edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    // a → b
    expect(edges.some((e) => e.source === 'step-a' && e.target === 'step-b')).toBe(true);
    // b → c
    expect(edges.some((e) => e.source === 'step-b' && e.target === 'step-c')).toBe(true);
  });

  it('maps node data correctly from step fields', () => {
    const { nodes } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    const nodeA = nodes.find((n) => n.id === 'step-a');
    expect(nodeA?.type).toBe('pattern');
    expect(nodeA?.data.label).toBe('Step A');
    expect(nodeA?.data.type).toBe('llm_call');
  });

  it('route step with 2 conditional edges produces 2 edges, one with a label', () => {
    const definition: WorkflowDefinition = {
      entryStepId: 'router',
      errorStrategy: 'fail',
      steps: [
        {
          id: 'router',
          name: 'Classify',
          type: 'route',
          config: {},
          nextSteps: [
            { targetStepId: 'path-yes', condition: 'sentiment == positive' },
            { targetStepId: 'path-no' },
          ],
        },
        { id: 'path-yes', name: 'Positive path', type: 'llm_call', config: {}, nextSteps: [] },
        { id: 'path-no', name: 'Negative path', type: 'llm_call', config: {}, nextSteps: [] },
      ],
    };

    const { edges } = workflowDefinitionToFlow(definition);

    expect(edges).toHaveLength(2);

    // The conditioned edge has a label
    const condEdge = edges.find((e) => e.target === 'path-yes');
    expect(condEdge?.label).toBe('sentiment == positive');

    // The unconditional edge has no label
    const unconditionalEdge = edges.find((e) => e.target === 'path-no');
    expect(unconditionalEdge?.label).toBeUndefined();
  });

  it('honours stored _layout x/y from step config', () => {
    const definition: WorkflowDefinition = {
      entryStepId: 'step-a',
      errorStrategy: 'fail',
      steps: [
        {
          id: 'step-a',
          name: 'Step A',
          type: 'llm_call',
          config: { _layout: { x: 350, y: 200 } },
          nextSteps: [],
        },
      ],
    };

    const { nodes } = workflowDefinitionToFlow(definition);

    expect(nodes[0].position).toEqual({ x: 350, y: 200 });
  });

  it('strips _layout from node data.config when it is stored in step config', () => {
    const definition: WorkflowDefinition = {
      entryStepId: 'step-a',
      errorStrategy: 'fail',
      steps: [
        {
          id: 'step-a',
          name: 'Step A',
          type: 'llm_call',
          config: { prompt: 'hello', _layout: { x: 10, y: 20 } },
          nextSteps: [],
        },
      ],
    };

    const { nodes } = workflowDefinitionToFlow(definition);

    // _layout should not be in data.config
    expect(nodes[0].data.config).not.toHaveProperty('_layout');
    expect(nodes[0].data.config).toHaveProperty('prompt', 'hello');
  });

  it('auto-layouts entry step at (0,0) when _layout is missing', () => {
    const { nodes } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    const entryNode = nodes.find((n) => n.id === 'step-a');
    expect(entryNode?.position).toEqual({ x: 0, y: 0 });
  });

  it('auto-layouts next step at (270,40) in a linear chain (staggered)', () => {
    const { nodes } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    const stepB = nodes.find((n) => n.id === 'step-b');
    expect(stepB?.position).toEqual({ x: 220, y: 40 });
  });

  it('auto-layouts third step at (440,0) in a linear chain', () => {
    const { nodes } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    const stepC = nodes.find((n) => n.id === 'step-c');
    expect(stepC?.position).toEqual({ x: 440, y: 0 });
  });
});

describe('flowToWorkflowDefinition', () => {
  function makeNode(id: string, label: string, type: string, x = 0, y = 0): PatternNode {
    return {
      id,
      type: 'pattern',
      position: { x, y },
      data: { label, type, config: { prompt: 'test' } },
    };
  }

  it('round-trip preserves step ids', () => {
    const { nodes, edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);
    const result = flowToWorkflowDefinition(nodes, edges);

    const resultIds = result.steps.map((s) => s.id);
    expect(resultIds).toContain('step-a');
    expect(resultIds).toContain('step-b');
    expect(resultIds).toContain('step-c');
  });

  it('round-trip preserves step names', () => {
    const { nodes, edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);
    const result = flowToWorkflowDefinition(nodes, edges);

    const stepA = result.steps.find((s) => s.id === 'step-a');
    expect(stepA?.name).toBe('Step A');
  });

  it('round-trip preserves step types', () => {
    const { nodes, edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);
    const result = flowToWorkflowDefinition(nodes, edges);

    const stepA = result.steps.find((s) => s.id === 'step-a');
    expect(stepA?.type).toBe('llm_call');
  });

  it('writes _layout into every step config', () => {
    const nodeA = makeNode('a', 'A', 'llm_call', 100, 200);
    const result = flowToWorkflowDefinition([nodeA], []);

    expect(result.steps[0].config).toHaveProperty('_layout');
    const layout = result.steps[0].config._layout as { x: number; y: number };
    expect(layout.x).toBe(100);
    expect(layout.y).toBe(200);
  });

  it('does not nest _layout when config already has _layout', () => {
    const nodeA: PatternNode = {
      id: 'a',
      type: 'pattern',
      position: { x: 50, y: 75 },
      // Simulate config that already has a stale _layout
      data: { label: 'A', type: 'llm_call', config: { _layout: { x: 999, y: 999 }, prompt: 'hi' } },
    };

    const result = flowToWorkflowDefinition([nodeA], []);
    const layout = result.steps[0].config._layout as { x: number; y: number };

    // Should use the position (50, 75), not the stale _layout (999, 999)
    expect(layout.x).toBe(50);
    expect(layout.y).toBe(75);

    // Should not have nested _layout
    expect(result.steps[0].config._layout).not.toHaveProperty('_layout');
  });

  it('entryStepId defaults to first node with no incoming edge', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const nodeB = makeNode('b', 'B', 'llm_call');
    const edge = { id: 'e1', source: 'a', target: 'b', type: 'default' };

    const result = flowToWorkflowDefinition([nodeA, nodeB], [edge]);

    // a has no incoming edge; b has one incoming (from a)
    expect(result.entryStepId).toBe('a');
  });

  it('entryStepId falls back to first node when all have incoming edges (cycle)', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const nodeB = makeNode('b', 'B', 'llm_call');
    // Both have incoming edges (cycle: a←b, b←a)
    const edgeAB = { id: 'e1', source: 'a', target: 'b', type: 'default' };
    const edgeBA = { id: 'e2', source: 'b', target: 'a', type: 'default' };

    const result = flowToWorkflowDefinition([nodeA, nodeB], [edgeAB, edgeBA]);

    // Falls back to first node in list
    expect(result.entryStepId).toBe('a');
  });

  it('honours explicit entryStepId option when the id exists', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const nodeB = makeNode('b', 'B', 'llm_call');
    const edge = { id: 'e1', source: 'a', target: 'b', type: 'default' };

    const result = flowToWorkflowDefinition([nodeA, nodeB], [edge], { entryStepId: 'b' });

    expect(result.entryStepId).toBe('b');
  });

  it('falls back from an explicit entryStepId that does not resolve to a node', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const nodeB = makeNode('b', 'B', 'llm_call');
    const edge = { id: 'e1', source: 'a', target: 'b', type: 'default' };

    const result = flowToWorkflowDefinition([nodeA, nodeB], [edge], {
      entryStepId: 'nonexistent',
    });

    // Should pick first node with no incoming edge: 'a'
    expect(result.entryStepId).toBe('a');
  });

  it('preserves errorStrategy option', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const result = flowToWorkflowDefinition([nodeA], [], { errorStrategy: 'retry' });

    expect(result.errorStrategy).toBe('retry');
  });

  it('defaults errorStrategy to "fail"', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const result = flowToWorkflowDefinition([nodeA], []);

    expect(result.errorStrategy).toBe('fail');
  });

  it('builds nextSteps from edges correctly', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const nodeB = makeNode('b', 'B', 'llm_call');
    const edge = { id: 'e1', source: 'a', target: 'b', type: 'default', label: 'condition1' };

    const result = flowToWorkflowDefinition([nodeA, nodeB], [edge]);

    const stepA = result.steps.find((s) => s.id === 'a');
    expect(stepA?.nextSteps).toHaveLength(1);
    expect(stepA?.nextSteps[0].targetStepId).toBe('b');
    expect(stepA?.nextSteps[0].condition).toBe('condition1');
  });

  it('omits condition key when edge label is empty', () => {
    const nodeA = makeNode('a', 'A', 'llm_call');
    const nodeB = makeNode('b', 'B', 'llm_call');
    const edge = { id: 'e1', source: 'a', target: 'b', type: 'default', label: '' };

    const result = flowToWorkflowDefinition([nodeA, nodeB], [edge]);

    const stepA = result.steps.find((s) => s.id === 'a');
    expect(stepA?.nextSteps[0]).not.toHaveProperty('condition');
  });
});
