/**
 * Unit Tests: runExtraChecks
 *
 * Test Coverage:
 * - DISCONNECTED_NODE: non-entry orphan node is flagged
 * - DISCONNECTED_NODE: entry node with no incoming edges is NOT flagged
 * - PARALLEL_WITHOUT_MERGE: branches that reconverge at a common node → clean
 * - PARALLEL_WITHOUT_MERGE: branches that never merge → flagged
 * - MISSING_REQUIRED_CONFIG: llm_call with empty prompt
 * - MISSING_REQUIRED_CONFIG: route with <2 branch labels
 * - MISSING_REQUIRED_CONFIG: rag_retrieve with empty query
 * - MISSING_REQUIRED_CONFIG: tool_call with no capabilitySlug
 * - MISSING_REQUIRED_CONFIG: human_approval with empty prompt
 * - CYCLE_DETECTED: 2-node cycle, 3-node cycle, self-loop, diamond-with-cycle
 * - DANGLING_EDGE: edge referencing deleted source or target node
 *
 * @see components/admin/orchestration/workflow-builder/extra-checks.ts
 */

import { describe, it, expect } from 'vitest';
import type { Edge } from '@xyflow/react';

import { runExtraChecks } from '@/components/admin/orchestration/workflow-builder/extra-checks';
import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(
  id: string,
  type: string,
  config: Record<string, unknown> = {},
  label = 'My Step'
): PatternNode {
  return {
    id,
    type: 'pattern',
    position: { x: 0, y: 0 },
    data: { label, type: type, config },
  };
}

function makeEdge(source: string, target: string): Edge {
  return {
    id: `${source}->${target}`,
    source,
    target,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('runExtraChecks', () => {
  describe('DISCONNECTED_NODE', () => {
    it('flags a non-entry node that has no incoming and no outgoing edges', () => {
      // entry: nodeA (has outgoing), orphan: nodeB (no edges at all)
      const nodes = [
        makeNode('nodeA', 'llm_call', { prompt: 'hello' }, 'Node A'),
        makeNode('nodeB', 'chain', {}, 'Orphan Node'),
      ];
      const edges = [makeEdge('nodeA', 'nodeC')]; // nodeA connects to something else

      const errors = runExtraChecks(nodes, edges);
      const disconnected = errors.filter((e) => e.code === 'DISCONNECTED_NODE');
      expect(disconnected).toHaveLength(1);
      expect(disconnected[0].stepId).toBe('nodeB');
    });

    it('does NOT flag the entry node even when it has no incoming edges', () => {
      // Single node: the entry, no edges
      const nodes = [makeNode('entry', 'llm_call', { prompt: 'hello' }, 'Entry')];
      const edges: Edge[] = [];

      const errors = runExtraChecks(nodes, edges);
      const disconnected = errors.filter((e) => e.code === 'DISCONNECTED_NODE');
      expect(disconnected).toHaveLength(0);
    });

    it('does NOT flag a node that has an outgoing edge (partial connection)', () => {
      // Two nodes: entry → nodeB. nodeB has an incoming edge.
      const nodes = [
        makeNode('entry', 'llm_call', { prompt: 'hi' }, 'Entry'),
        makeNode('nodeB', 'chain', {}, 'B'),
      ];
      const edges = [makeEdge('entry', 'nodeB')];

      const errors = runExtraChecks(nodes, edges);
      const disconnected = errors.filter((e) => e.code === 'DISCONNECTED_NODE');
      expect(disconnected).toHaveLength(0);
    });
  });

  describe('PARALLEL_WITHOUT_MERGE', () => {
    it('does NOT flag a parallel step whose branches reconverge at a common node', () => {
      // parallel → branchA → merge
      //           → branchB → merge
      const nodes = [
        makeNode('parallel', 'parallel', {}, 'Parallel'),
        makeNode('branchA', 'llm_call', { prompt: 'a' }, 'Branch A'),
        makeNode('branchB', 'llm_call', { prompt: 'b' }, 'Branch B'),
        makeNode('merge', 'chain', {}, 'Merge'),
      ];
      const edges = [
        makeEdge('parallel', 'branchA'),
        makeEdge('parallel', 'branchB'),
        makeEdge('branchA', 'merge'),
        makeEdge('branchB', 'merge'),
      ];

      const errors = runExtraChecks(nodes, edges);
      const parallelErrors = errors.filter((e) => e.code === 'PARALLEL_WITHOUT_MERGE');
      expect(parallelErrors).toHaveLength(0);
    });

    it('flags a parallel step whose branches never merge', () => {
      // parallel → branchA (dead end)
      //           → branchB (dead end)
      const nodes = [
        makeNode('parallel', 'parallel', {}, 'Parallel'),
        makeNode('branchA', 'llm_call', { prompt: 'a' }, 'Branch A'),
        makeNode('branchB', 'llm_call', { prompt: 'b' }, 'Branch B'),
      ];
      const edges = [makeEdge('parallel', 'branchA'), makeEdge('parallel', 'branchB')];

      const errors = runExtraChecks(nodes, edges);
      const parallelErrors = errors.filter((e) => e.code === 'PARALLEL_WITHOUT_MERGE');
      expect(parallelErrors).toHaveLength(1);
      expect(parallelErrors[0].stepId).toBe('parallel');
    });

    it('does NOT flag a parallel node with a single outgoing edge (not finished wiring)', () => {
      const nodes = [
        makeNode('parallel', 'parallel', {}, 'Parallel'),
        makeNode('branchA', 'chain', {}, 'Branch A'),
      ];
      const edges = [makeEdge('parallel', 'branchA')];

      const errors = runExtraChecks(nodes, edges);
      const parallelErrors = errors.filter((e) => e.code === 'PARALLEL_WITHOUT_MERGE');
      expect(parallelErrors).toHaveLength(0);
    });
  });

  describe('MISSING_REQUIRED_CONFIG', () => {
    it('flags llm_call with an empty prompt', () => {
      const nodes = [makeNode('n1', 'llm_call', { prompt: '' }, 'LLM Node')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(1);
      expect(missing[0].stepId).toBe('n1');
    });

    it('does NOT flag llm_call when prompt is non-empty', () => {
      const nodes = [makeNode('n1', 'llm_call', { prompt: 'Say hello' }, 'LLM Node')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(0);
    });

    it('flags route with fewer than 2 branch labels', () => {
      const nodes = [
        makeNode(
          'n1',
          'route',
          { classificationPrompt: 'Classify it', routes: [{ label: 'yes' }] },
          'Route'
        ),
      ];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      // Flags the routes count error (1 branch only), not the classification prompt
      expect(missing.some((e) => e.stepId === 'n1')).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    });

    it('flags route with no classificationPrompt and no routes', () => {
      const nodes = [makeNode('n1', 'route', { classificationPrompt: '', routes: [] }, 'Route')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      // Both classificationPrompt and routes <2 should be flagged
      expect(missing.length).toBeGreaterThanOrEqual(2);
    });

    it('does NOT flag route when classificationPrompt and ≥2 branches are set', () => {
      const nodes = [
        makeNode(
          'n1',
          'route',
          { classificationPrompt: 'Classify', routes: [{ label: 'yes' }, { label: 'no' }] },
          'Route'
        ),
      ];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(0);
    });

    it('flags rag_retrieve with empty query', () => {
      const nodes = [makeNode('n1', 'rag_retrieve', { query: '' }, 'RAG')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(1);
      expect(missing[0].stepId).toBe('n1');
    });

    it('flags tool_call with no capabilitySlug', () => {
      const nodes = [makeNode('n1', 'tool_call', { capabilitySlug: '' }, 'Tool')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(1);
      expect(missing[0].stepId).toBe('n1');
    });

    it('flags human_approval with empty prompt', () => {
      const nodes = [makeNode('n1', 'human_approval', { prompt: '' }, 'Approval')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(1);
      expect(missing[0].stepId).toBe('n1');
    });

    it('flags guard with empty rules', () => {
      const nodes = [makeNode('n1', 'guard', { rules: '' }, 'Guard')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(1);
      expect(missing[0].stepId).toBe('n1');
    });

    it('flags evaluate with empty rubric', () => {
      const nodes = [makeNode('n1', 'evaluate', { rubric: '' }, 'Evaluate')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(1);
      expect(missing[0].stepId).toBe('n1');
    });

    it('flags external_call with empty url', () => {
      const nodes = [makeNode('n1', 'external_call', { url: '' }, 'External')];
      const errors = runExtraChecks(nodes, []);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(1);
      expect(missing[0].stepId).toBe('n1');
    });

    it('does NOT flag chain or parallel (no required config)', () => {
      const nodes = [
        makeNode('n1', 'chain', {}, 'Chain'),
        makeNode('n2', 'parallel', {}, 'Parallel'),
      ];
      const edges: Edge[] = [];
      const errors = runExtraChecks(nodes, edges);
      const missing = errors.filter((e) => e.code === 'MISSING_REQUIRED_CONFIG');
      expect(missing).toHaveLength(0);
    });
  });

  describe('CYCLE_DETECTED', () => {
    it('flags a 2-node cycle (A→B→A)', () => {
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
      ];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'a')];

      const errors = runExtraChecks(nodes, edges);
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].message).toContain('Cycle detected');
    });

    it('flags a 3-node cycle (A→B→C→A)', () => {
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
        makeNode('c', 'chain', {}, 'C'),
      ];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'c'), makeEdge('c', 'a')];

      const errors = runExtraChecks(nodes, edges);
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].message).toContain('a');
      expect(cycles[0].message).toContain('b');
      expect(cycles[0].message).toContain('c');
    });

    it('flags a self-loop (A→A)', () => {
      const nodes = [makeNode('a', 'chain', {}, 'A')];
      const edges = [makeEdge('a', 'a')];

      const errors = runExtraChecks(nodes, edges);
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].stepId).toBe('a');
    });

    it('flags a diamond-with-back-edge cycle (A→B, A→C, B→D, C→D, D→A)', () => {
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
        makeNode('c', 'chain', {}, 'C'),
        makeNode('d', 'chain', {}, 'D'),
      ];
      const edges = [
        makeEdge('a', 'b'),
        makeEdge('a', 'c'),
        makeEdge('b', 'd'),
        makeEdge('c', 'd'),
        makeEdge('d', 'a'),
      ];

      const errors = runExtraChecks(nodes, edges);
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles.length).toBeGreaterThanOrEqual(1);
      expect(cycles[0].message).toContain('Cycle detected');
    });

    it('does NOT flag a DAG (no cycles)', () => {
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
        makeNode('c', 'chain', {}, 'C'),
      ];
      const edges = [makeEdge('a', 'b'), makeEdge('b', 'c')];

      const errors = runExtraChecks(nodes, edges);
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(0);
    });
  });

  describe('DANGLING_EDGE', () => {
    it('flags an edge whose target node no longer exists', () => {
      const nodes = [makeNode('a', 'chain', {}, 'A')];
      // Edge points to 'deleted' which is not in the node list
      const edges = [makeEdge('a', 'deleted')];

      const errors = runExtraChecks(nodes, edges);
      const dangling = errors.filter((e) => e.code === 'DANGLING_EDGE');
      expect(dangling).toHaveLength(1);
    });

    it('flags an edge whose source node no longer exists', () => {
      const nodes = [makeNode('b', 'chain', {}, 'B')];
      // Edge from 'deleted' which is not in the node list
      const edges = [makeEdge('deleted', 'b')];

      const errors = runExtraChecks(nodes, edges);
      const dangling = errors.filter((e) => e.code === 'DANGLING_EDGE');
      expect(dangling).toHaveLength(1);
    });

    it('does NOT flag edges when both source and target exist', () => {
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
      ];
      const edges = [makeEdge('a', 'b')];

      const errors = runExtraChecks(nodes, edges);
      const dangling = errors.filter((e) => e.code === 'DANGLING_EDGE');
      expect(dangling).toHaveLength(0);
    });
  });

  describe('empty canvas', () => {
    it('returns no errors for an empty canvas', () => {
      expect(runExtraChecks([], [])).toHaveLength(0);
    });
  });

  describe('CYCLE_DETECTED — bounded retry back-edges', () => {
    it('still flags a back-edge when maxRetries is present but NO condition (label is absent)', () => {
      // Arrange — B→A carries maxRetries in edge.data but no label at all.
      // The checkCycles gate requires BOTH maxRetries > 0 AND condition to skip flagging.
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
      ];
      const edges = [
        makeEdge('a', 'b'),
        {
          id: 'b->a',
          source: 'b',
          target: 'a',
          // No label — condition field will be undefined
          data: { maxRetries: 3 },
        },
      ];

      // Act
      const errors = runExtraChecks(nodes, edges);

      // Assert — no condition means it's still a plain cycle even with maxRetries
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].message).toContain('Cycle detected');
    });

    it('still flags a back-edge when maxRetries is 0 even with a condition label', () => {
      // Arrange — B→A has label (condition) but maxRetries=0: the guard
      // requires maxRetries > 0, so zero is treated as no retry cap → cycle.
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
      ];
      const edges = [
        makeEdge('a', 'b'),
        {
          id: 'b->a',
          source: 'b',
          target: 'a',
          label: 'retry condition',
          data: { maxRetries: 0 },
        },
      ];

      // Act
      const errors = runExtraChecks(nodes, edges);

      // Assert — maxRetries=0 means the bounded-retry exemption is not granted
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].message).toContain('Cycle detected');
    });

    it('does NOT flag a back-edge that has maxRetries in edge data AND a non-empty label (condition)', () => {
      // Arrange — A → B → A, but B→A carries maxRetries=3 in data and a label acting as condition.
      // The frontend checkCycles reads maxRetries from edge.data and condition from edge.label.
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'llm_call', { prompt: 'bye' }, 'B'),
      ];
      const edges = [
        makeEdge('a', 'b'),
        {
          id: 'b->a',
          source: 'b',
          target: 'a',
          label: 'retry',
          data: { maxRetries: 3 },
        },
      ];

      // Act
      const errors = runExtraChecks(nodes, edges);

      // Assert — the bounded retry back-edge must not be flagged as a cycle
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(0);
    });

    it('still flags a back-edge that has NO maxRetries in edge data even when a label is present', () => {
      // Arrange — B→A has a label but maxRetries is absent: unbounded cycle must be caught
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
      ];
      const edges = [
        makeEdge('a', 'b'),
        {
          id: 'b->a',
          source: 'b',
          target: 'a',
          label: 'retry',
          // no data / no maxRetries
        },
      ];

      // Act
      const errors = runExtraChecks(nodes, edges);

      // Assert — no maxRetries means it's still a plain cycle
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(1);
      expect(cycles[0].message).toContain('Cycle detected');
    });

    it('still flags a back-edge that has maxRetries in edge data but an empty label (no condition)', () => {
      // Arrange — B→A carries maxRetries but the label is empty: both fields are required
      const nodes = [
        makeNode('a', 'llm_call', { prompt: 'hi' }, 'A'),
        makeNode('b', 'chain', {}, 'B'),
      ];
      const edges = [
        makeEdge('a', 'b'),
        {
          id: 'b->a',
          source: 'b',
          target: 'a',
          label: '',
          data: { maxRetries: 3 },
        },
      ];

      // Act
      const errors = runExtraChecks(nodes, edges);

      // Assert — empty label means condition is absent; cycle must be flagged
      const cycles = errors.filter((e) => e.code === 'CYCLE_DETECTED');
      expect(cycles).toHaveLength(1);
    });
  });
});
