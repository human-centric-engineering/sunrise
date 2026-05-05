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
 * - workflowDefinitionToFlow: guard step edges get sourceHandle from condition match
 * - workflowDefinitionToFlow: edges get targetHandle 'in-0'
 * - flowToWorkflowDefinition: derives condition from sourceHandle when label is missing
 * - flowToWorkflowDefinition: label takes priority over sourceHandle-derived condition
 *
 * @see components/admin/orchestration/workflow-builder/workflow-mappers.ts
 */

import { describe, it, expect } from 'vitest';

import {
  workflowDefinitionToFlow,
  flowToWorkflowDefinition,
  stripLayout,
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

describe('stripLayout', () => {
  it('removes the _layout key from a config object', () => {
    const config = { prompt: 'hello', _layout: { x: 100, y: 200 } };
    const result = stripLayout(config);
    expect(result).not.toHaveProperty('_layout');
  });

  it('preserves all other keys unchanged', () => {
    const config = { prompt: 'hello', model: 'gpt-4', _layout: { x: 0, y: 0 } };
    const result = stripLayout(config);
    expect(result.prompt).toBe('hello');
    expect(result.model).toBe('gpt-4');
  });

  it('returns the same object reference when _layout is not present', () => {
    const config = { prompt: 'hello', model: 'gpt-4' };
    const result = stripLayout(config);
    expect(result).toBe(config);
  });

  it('does not mutate the original config object', () => {
    const config = { prompt: 'hello', _layout: { x: 1, y: 2 } };
    stripLayout(config);
    expect(config).toHaveProperty('_layout');
  });

  it('handles an empty config object', () => {
    const result = stripLayout({});
    expect(result).toEqual({});
  });
});

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
    expect(edges.some((e) => e.source === 'step-a' && e.target === 'step-b')).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    // b → c
    expect(edges.some((e) => e.source === 'step-b' && e.target === 'step-c')).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
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

  it('auto-layouts next step at (220,40) in a linear chain (staggered)', () => {
    const { nodes } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    const stepB = nodes.find((n) => n.id === 'step-b');
    expect(stepB?.position).toEqual({ x: 220, y: 40 });
  });

  it('auto-layouts third step at (440,0) in a linear chain', () => {
    const { nodes } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    const stepC = nodes.find((n) => n.id === 'step-c');
    expect(stepC?.position).toEqual({ x: 440, y: 0 });
  });

  it('guard step edges get sourceHandle matching the condition label', () => {
    const definition: WorkflowDefinition = {
      entryStepId: 'guard',
      errorStrategy: 'fail',
      steps: [
        {
          id: 'guard',
          name: 'Guard',
          type: 'guard',
          config: {},
          nextSteps: [
            { targetStepId: 'pass-target', condition: 'pass' },
            { targetStepId: 'fail-target', condition: 'fail' },
          ],
        },
        { id: 'pass-target', name: 'Pass', type: 'llm_call', config: {}, nextSteps: [] },
        { id: 'fail-target', name: 'Fail', type: 'llm_call', config: {}, nextSteps: [] },
      ],
    };

    const { edges } = workflowDefinitionToFlow(definition);

    const passEdge = edges.find((e) => e.target === 'pass-target');
    expect(passEdge?.sourceHandle).toBe('out-0');

    const failEdge = edges.find((e) => e.target === 'fail-target');
    expect(failEdge?.sourceHandle).toBe('out-1');
  });

  it('edges get targetHandle "in-0"', () => {
    const { edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

    for (const edge of edges) {
      expect(edge.targetHandle).toBe('in-0');
    }
  });

  describe('retry edges', () => {
    it('sets type "retry" on an edge whose ConditionalEdge has maxRetries > 0', () => {
      // Arrange — a back-edge from B to A carrying maxRetries:2 and a condition
      const definition: WorkflowDefinition = {
        entryStepId: 'a',
        errorStrategy: 'fail',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'a', maxRetries: 2, condition: 'fail' }],
          },
        ],
      };

      // Act
      const { edges } = workflowDefinitionToFlow(definition);

      // Assert — the retry back-edge gets type:'retry', not 'default'
      const retryEdge = edges.find((e) => e.source === 'b' && e.target === 'a');
      expect(retryEdge).toBeDefined();
      expect(retryEdge?.type).toBe('retry');
    });

    it('includes "(retry ×N)" in the label of a retry edge, preserving the condition prefix', () => {
      // Arrange — a retry edge with condition 'fail' and maxRetries 3
      const definition: WorkflowDefinition = {
        entryStepId: 'a',
        errorStrategy: 'fail',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'a', maxRetries: 3, condition: 'fail' }],
          },
        ],
      };

      // Act
      const { edges } = workflowDefinitionToFlow(definition);

      // Assert — label is "fail (retry ×3)" — condition + retry annotation
      const retryEdge = edges.find((e) => e.source === 'b' && e.target === 'a');
      expect(retryEdge?.label).toBe('fail (retry \u00d73)');
    });

    it('stores maxRetries in edge data so the round-trip mapper can read it back', () => {
      // Arrange — retry edge with maxRetries:2
      const definition: WorkflowDefinition = {
        entryStepId: 'a',
        errorStrategy: 'fail',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'a', maxRetries: 2, condition: 'fail' }],
          },
        ],
      };

      // Act
      const { edges } = workflowDefinitionToFlow(definition);

      // Assert — edge.data.maxRetries carries the value the mapper needs on round-trip
      const retryEdge = edges.find((e) => e.source === 'b' && e.target === 'a');
      expect(retryEdge?.data?.maxRetries).toBe(2);
    });

    it('uses type "default" and no retry label for a plain (non-retry) edge', () => {
      // Arrange — a normal unconditional edge has no maxRetries
      const { edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);

      // Act + Assert — all edges in the linear chain must be 'default', not 'retry'
      for (const edge of edges) {
        expect(edge.type).toBe('default');
      }
    });

    it('surfaces edge _layout to React Flow edge.data.controlPoint', () => {
      // Arrange — retry edge with a persisted control point
      const definition: WorkflowDefinition = {
        entryStepId: 'a',
        errorStrategy: 'fail',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'llm_call',
            config: {},
            nextSteps: [
              {
                targetStepId: 'a',
                maxRetries: 2,
                condition: 'fail',
                _layout: { controlPointX: 250, controlPointY: -120 },
              },
            ],
          },
        ],
      };

      // Act
      const { edges } = workflowDefinitionToFlow(definition);

      // Assert — control point is surfaced for the custom edge component
      const retryEdge = edges.find((e) => e.source === 'b' && e.target === 'a');
      expect(retryEdge?.data?.controlPoint).toEqual({ x: 250, y: -120 });
    });

    it('omits controlPoint from edge.data when no _layout is present', () => {
      const { edges } = workflowDefinitionToFlow(LINEAR_3_DEFINITION);
      for (const edge of edges) {
        expect(edge.data?.controlPoint).toBeUndefined();
      }
    });
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

  it('derives condition from sourceHandle when edge has no label', () => {
    const guardNode: PatternNode = {
      id: 'guard',
      type: 'pattern',
      position: { x: 0, y: 0 },
      data: { label: 'Guard', type: 'guard', config: {} },
    };
    const passNode = makeNode('pass', 'Pass Target', 'llm_call');
    const edge = {
      id: 'e1',
      source: 'guard',
      target: 'pass',
      type: 'default',
      sourceHandle: 'out-0',
    };

    const result = flowToWorkflowDefinition([guardNode, passNode], [edge]);

    const guardStep = result.steps.find((s) => s.id === 'guard');
    expect(guardStep?.nextSteps[0].condition).toBe('pass');
  });

  describe('maxRetries round-trip', () => {
    it('strips the "(retry ×N)" suffix from the label so the stored condition is clean', () => {
      // Arrange — an edge whose label was produced by workflowDefinitionToFlow for a retry edge
      const guardNode: PatternNode = {
        id: 'guard',
        type: 'pattern',
        position: { x: 0, y: 0 },
        data: { label: 'Guard', type: 'guard', config: {} },
      };
      const targetNode = makeNode('target', 'Target', 'llm_call');
      // Simulate the label as workflowDefinitionToFlow would produce it: "fail (retry ×2)"
      const edge = {
        id: 'e1',
        source: 'guard',
        target: 'target',
        type: 'retry',
        label: 'fail (retry \u00d72)',
        data: { maxRetries: 2 },
      };

      // Act
      const result = flowToWorkflowDefinition([guardNode, targetNode], [edge]);

      // Assert — the stored condition is "fail" with no retry suffix
      const guardStep = result.steps.find((s) => s.id === 'guard');
      expect(guardStep?.nextSteps[0].condition).toBe('fail');
    });

    it('preserves maxRetries from edge data on the round-tripped ConditionalEdge', () => {
      // Arrange — a retry edge whose data.maxRetries=3 must survive the round-trip
      const nodeA = makeNode('a', 'A', 'llm_call');
      const nodeB = makeNode('b', 'B', 'llm_call');
      const edge = {
        id: 'e1',
        source: 'b',
        target: 'a',
        type: 'retry',
        label: 'retry-condition (retry \u00d73)',
        data: { maxRetries: 3 },
      };

      // Act
      const result = flowToWorkflowDefinition([nodeA, nodeB], [edge]);

      // Assert — maxRetries is preserved on the ConditionalEdge written to the definition
      const stepB = result.steps.find((s) => s.id === 'b');
      expect(stepB?.nextSteps).toHaveLength(1);
      expect(stepB?.nextSteps[0].maxRetries).toBe(3);
    });

    it('omits maxRetries on the ConditionalEdge when edge data has none', () => {
      // Arrange — a normal edge without retry metadata
      const nodeA = makeNode('a', 'A', 'llm_call');
      const nodeB = makeNode('b', 'B', 'llm_call');
      const edge = { id: 'e1', source: 'a', target: 'b', type: 'default' };

      // Act
      const result = flowToWorkflowDefinition([nodeA, nodeB], [edge]);

      // Assert — no maxRetries key on a plain edge
      const stepA = result.steps.find((s) => s.id === 'a');
      expect(stepA?.nextSteps[0]).not.toHaveProperty('maxRetries');
    });

    it('writes ConditionalEdge._layout from edge.data.controlPoint', () => {
      const nodeA = makeNode('a', 'A', 'llm_call');
      const nodeB = makeNode('b', 'B', 'llm_call');
      const edge = {
        id: 'e1',
        source: 'b',
        target: 'a',
        type: 'retry',
        label: 'fail (retry ×2)',
        data: { maxRetries: 2, controlPoint: { x: 320, y: -90 } },
      };

      const result = flowToWorkflowDefinition([nodeA, nodeB], [edge]);
      const stepB = result.steps.find((s) => s.id === 'b');
      expect(stepB?.nextSteps[0]._layout).toEqual({
        controlPointX: 320,
        controlPointY: -90,
      });
    });

    it('omits _layout when edge.data has no controlPoint', () => {
      const nodeA = makeNode('a', 'A', 'llm_call');
      const nodeB = makeNode('b', 'B', 'llm_call');
      const edge = {
        id: 'e1',
        source: 'b',
        target: 'a',
        type: 'retry',
        label: 'fail (retry ×2)',
        data: { maxRetries: 2 },
      };

      const result = flowToWorkflowDefinition([nodeA, nodeB], [edge]);
      const stepB = result.steps.find((s) => s.id === 'b');
      expect(stepB?.nextSteps[0]).not.toHaveProperty('_layout');
    });

    it('round-trips _layout through workflowDefinitionToFlow + flowToWorkflowDefinition', () => {
      const definition: WorkflowDefinition = {
        entryStepId: 'a',
        errorStrategy: 'fail',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'b' }],
          },
          {
            id: 'b',
            name: 'B',
            type: 'llm_call',
            config: {},
            nextSteps: [
              {
                targetStepId: 'a',
                condition: 'fail',
                maxRetries: 2,
                _layout: { controlPointX: 200, controlPointY: -50 },
              },
            ],
          },
        ],
      };

      const { nodes, edges } = workflowDefinitionToFlow(definition);
      const result = flowToWorkflowDefinition(nodes, edges);

      const stepB = result.steps.find((s) => s.id === 'b');
      const retryEdge = stepB?.nextSteps.find((e) => e.targetStepId === 'a');
      expect(retryEdge?._layout).toEqual({ controlPointX: 200, controlPointY: -50 });
    });
  });

  it('label takes priority over sourceHandle-derived condition', () => {
    const guardNode: PatternNode = {
      id: 'guard',
      type: 'pattern',
      position: { x: 0, y: 0 },
      data: { label: 'Guard', type: 'guard', config: {} },
    };
    const targetNode = makeNode('target', 'Target', 'llm_call');
    const edge = {
      id: 'e1',
      source: 'guard',
      target: 'target',
      type: 'default',
      label: 'custom-condition',
      sourceHandle: 'out-0',
    };

    const result = flowToWorkflowDefinition([guardNode, targetNode], [edge]);

    const guardStep = result.steps.find((s) => s.id === 'guard');
    expect(guardStep?.nextSteps[0].condition).toBe('custom-condition');
  });
});
