/**
 * Unit Tests: add-node
 *
 * Test Coverage:
 * - makeStepId returns unique ids
 * - addNode returns correct node shape for a known type
 * - addNode clones defaultConfig — mutations do not affect the registry
 * - addNode returns null for unknown types
 *
 * @see components/admin/orchestration/workflow-builder/add-node.ts
 */

import { describe, it, expect } from 'vitest';

import { addNode, makeStepId } from '@/components/admin/orchestration/workflow-builder/add-node';
import { getStepMetadata } from '@/lib/orchestration/engine/step-registry';

describe('makeStepId', () => {
  it('returns a string starting with "step_"', () => {
    const id = makeStepId();
    expect(id.startsWith('step_')).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
  });

  it('returns unique ids across 5 calls', () => {
    const ids = Array.from({ length: 5 }, () => makeStepId());
    const unique = new Set(ids);
    expect(unique.size).toBe(5);
  });

  it('returns a consistent-length suffix (8 chars after step_)', () => {
    const id = makeStepId();
    const suffix = id.slice('step_'.length);
    expect(suffix.length).toBe(8);
  });
});

describe('addNode', () => {
  it('returns a node with type "pattern" for a known step type', () => {
    const node = addNode('llm_call', { x: 100, y: 200 });
    expect(node).not.toBeNull();
    expect(node?.type).toBe('pattern');
  });

  it('returns a node with the correct canvas position', () => {
    const node = addNode('llm_call', { x: 100, y: 200 });
    expect(node?.position).toEqual({ x: 100, y: 200 });
  });

  it('returns a node with data.label matching the registry label', () => {
    const node = addNode('llm_call', { x: 0, y: 0 });
    expect(node?.data.label).toBe('LLM Call');
  });

  it('returns a node with data.type matching the step type', () => {
    const node = addNode('llm_call', { x: 0, y: 0 });
    expect(node?.data.type).toBe('llm_call');
  });

  it('returns a node with an id that starts with "step_"', () => {
    const node = addNode('llm_call', { x: 0, y: 0 });
    expect(node?.id.startsWith('step_')).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
  });

  it('data.config is a fresh copy — mutation does not affect the registry', () => {
    const node = addNode('llm_call', { x: 0, y: 0 });
    expect(node).not.toBeNull();

    // Mutate the node's config (config is already Record<string,unknown>)
    if (node !== null) {
      node.data.config.injected = 'polluted';
    }

    // Registry entry's defaultConfig should be unchanged
    const meta = getStepMetadata('llm_call');
    expect(meta?.defaultConfig).not.toHaveProperty('injected');
  });

  it('returns null for an unknown step type', () => {
    const node = addNode('not-a-real-type', { x: 0, y: 0 });
    expect(node).toBeNull();
  });

  it('works for every known step type without returning null', () => {
    const knownTypes = [
      'llm_call',
      'chain',
      'route',
      'parallel',
      'reflect',
      'tool_call',
      'plan',
      'human_approval',
      'rag_retrieve',
    ] as const;

    for (const type of knownTypes) {
      const node = addNode(type, { x: 0, y: 0 });
      expect(node, `addNode("${type}") should not be null`).not.toBeNull();
    }
  });
});
