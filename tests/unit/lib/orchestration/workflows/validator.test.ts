/**
 * Tests for the workflow DAG validator.
 *
 * Assertions are on error `code`, never on `message`, so these tests
 * survive wording tweaks. The same error codes are consumed by the
 * admin API `/validate` route and the Phase 5 engine.
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '@/lib/orchestration/workflows/validator';
import type { WorkflowDefinition } from '@/types/orchestration';

function def(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    steps: [],
    entryStepId: 'start',
    errorStrategy: 'fail',
    ...overrides,
  };
}

describe('validateWorkflow', () => {
  it('accepts a minimal single-step workflow', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'start',
        steps: [{ id: 'start', name: 'Start', type: 'llm_call', config: {}, nextSteps: [] }],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a two-step sequential chain', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'b' }],
          },
          { id: 'b', name: 'B', type: 'llm_call', config: {}, nextSteps: [] },
        ],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
  });

  it('flags a missing entry step', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'ghost',
        steps: [{ id: 'a', name: 'A', type: 'llm_call', config: {}, nextSteps: [] }],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'MISSING_ENTRY')).toBe(true);
  });

  it('flags an unknown nextSteps target', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'ghost' }],
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'UNKNOWN_TARGET');
    expect(err).toBeDefined();
    expect(err?.stepId).toBe('a');
  });

  it('flags an unreachable step', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          { id: 'a', name: 'A', type: 'llm_call', config: {}, nextSteps: [] },
          { id: 'orphan', name: 'Orphan', type: 'llm_call', config: {}, nextSteps: [] },
        ],
      })
    );
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'UNREACHABLE_STEP');
    expect(err?.stepId).toBe('orphan');
  });

  it('detects a direct cycle (A → B → A)', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
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
            nextSteps: [{ targetStepId: 'a' }],
          },
        ],
      })
    );
    expect(result.ok).toBe(false);
    const err = result.errors.find((e) => e.code === 'CYCLE_DETECTED');
    expect(err).toBeDefined();
    expect(err?.path).toBeDefined();
    expect(err?.path?.length).toBeGreaterThanOrEqual(2);
  });

  it('detects an indirect cycle (A → B → C → B)', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
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
            nextSteps: [{ targetStepId: 'c' }],
          },
          {
            id: 'c',
            name: 'C',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'b' }],
          },
        ],
      })
    );
    const err = result.errors.find((e) => e.code === 'CYCLE_DETECTED');
    expect(err).toBeDefined();
    expect(err?.path).toContain('b');
    expect(err?.path).toContain('c');
  });

  it('detects a self-loop (A → A)', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'llm_call',
            config: {},
            nextSteps: [{ targetStepId: 'a' }],
          },
        ],
      })
    );
    expect(result.errors.some((e) => e.code === 'CYCLE_DETECTED')).toBe(true);
  });

  it('flags duplicate step ids', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          { id: 'a', name: 'A1', type: 'llm_call', config: {}, nextSteps: [] },
          { id: 'a', name: 'A2', type: 'llm_call', config: {}, nextSteps: [] },
        ],
      })
    );
    expect(result.errors.some((e) => e.code === 'DUPLICATE_STEP_ID')).toBe(true);
  });

  it('flags human_approval missing prompt', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [{ id: 'a', name: 'A', type: 'human_approval', config: {}, nextSteps: [] }],
      })
    );
    const err = result.errors.find((e) => e.code === 'MISSING_APPROVAL_PROMPT');
    expect(err?.stepId).toBe('a');
  });

  it('accepts human_approval with a prompt', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'human_approval',
            config: { prompt: 'Approve this?' },
            nextSteps: [],
          },
        ],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
  });

  it('flags tool_call missing capabilitySlug', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [{ id: 'a', name: 'A', type: 'tool_call', config: {}, nextSteps: [] }],
      })
    );
    const err = result.errors.find((e) => e.code === 'MISSING_CAPABILITY_SLUG');
    expect(err?.stepId).toBe('a');
  });

  it('accepts tool_call with capabilitySlug', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'tool_call',
            config: { capabilitySlug: 'web-search' },
            nextSteps: [],
          },
        ],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
  });

  it('flags guard step missing rules', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [{ id: 'a', name: 'A', type: 'guard', config: {}, nextSteps: [] }],
      })
    );
    const err = result.errors.find((e) => e.code === 'MISSING_GUARD_RULES');
    expect(err?.stepId).toBe('a');
  });

  it('accepts guard step with rules', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'guard',
            config: { rules: 'No PII allowed' },
            nextSteps: [],
          },
        ],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
  });

  it('flags evaluate step missing rubric', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [{ id: 'a', name: 'A', type: 'evaluate', config: {}, nextSteps: [] }],
      })
    );
    const err = result.errors.find((e) => e.code === 'MISSING_EVALUATE_RUBRIC');
    expect(err?.stepId).toBe('a');
  });

  it('accepts evaluate step with rubric', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'evaluate',
            config: { rubric: 'Score clarity 1-10' },
            nextSteps: [],
          },
        ],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
  });

  it('flags external_call step missing url', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [{ id: 'a', name: 'A', type: 'external_call', config: {}, nextSteps: [] }],
      })
    );
    const err = result.errors.find((e) => e.code === 'MISSING_EXTERNAL_URL');
    expect(err?.stepId).toBe('a');
  });

  it('accepts external_call step with url', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'external_call',
            config: { url: 'https://api.example.com/webhook' },
            nextSteps: [],
          },
        ],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
  });

  it('flags agent_call step missing agentSlug', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [{ id: 'a', name: 'A', type: 'agent_call', config: {}, nextSteps: [] }],
      })
    );
    const err = result.errors.find((e) => e.code === 'MISSING_AGENT_SLUG');
    expect(err?.stepId).toBe('a');
  });

  it('accepts agent_call step with agentSlug', () => {
    const result = validateWorkflow(
      def({
        entryStepId: 'a',
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'agent_call',
            config: { agentSlug: 'summarizer' },
            nextSteps: [],
          },
        ],
      })
    );
    // test-review:accept tobe_true — boolean field `ok` on WorkflowValidationResult; structural assertion on validation outcome
    expect(result.ok).toBe(true);
  });
});
