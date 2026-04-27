/**
 * Unit Tests: template-types (toTemplateItem + templateMetadataSchema)
 *
 * Test Coverage:
 * - templateMetadataSchema: validates a complete valid metadata object
 * - templateMetadataSchema: rejects missing required fields
 * - templateMetadataSchema: rejects wrong types
 * - toTemplateItem: maps a valid workflow row to a TemplateItem correctly
 * - toTemplateItem: workflowDefinition falls back to empty definition on invalid input
 * - toTemplateItem: metadata falls back to null on invalid input
 * - toTemplateItem: passes through slug, name, description, patternsUsed, isTemplate unchanged
 *
 * @see components/admin/orchestration/workflow-builder/template-types.ts
 */

import { describe, it, expect } from 'vitest';

import {
  templateMetadataSchema,
  toTemplateItem,
} from '@/components/admin/orchestration/workflow-builder/template-types';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_METADATA = {
  flowSummary: 'Runs a multi-step support triage.',
  useCases: [
    { title: 'Order Refund', scenario: 'Customer requests refund.' },
    { title: 'Track Order', scenario: 'Customer checks shipping status.' },
  ],
  patterns: [
    { number: 1, name: 'Chain of Thought' },
    { number: 5, name: 'ReAct' },
  ],
};

const VALID_WORKFLOW_DEFINITION = {
  steps: [
    {
      id: 'step-1',
      name: 'First Step',
      type: 'llm-call',
      config: {},
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
};

function makeWorkflow(
  overrides: Partial<{
    slug: string;
    name: string;
    description: string;
    workflowDefinition: unknown;
    patternsUsed: number[];
    isTemplate: boolean;
    metadata: unknown;
  }> = {}
) {
  return {
    slug: 'tpl-customer-support',
    name: 'Customer Support',
    description: 'Multi-channel support automation',
    workflowDefinition: VALID_WORKFLOW_DEFINITION,
    patternsUsed: [1, 5],
    isTemplate: true,
    metadata: VALID_METADATA,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('templateMetadataSchema', () => {
  describe('valid input', () => {
    it('parses a complete valid metadata object successfully', () => {
      const result = templateMetadataSchema.safeParse(VALID_METADATA);
      // test-review:accept tobe_true — Zod safeParse result success guard; structural schema contract assertion, not a degenerate "operation succeeded" check
      expect(result.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
      if (result.success) {
        expect(result.data.flowSummary).toBe(VALID_METADATA.flowSummary);
        expect(result.data.useCases).toHaveLength(2);
        expect(result.data.patterns).toHaveLength(2);
      }
    });

    it('parses metadata with empty useCases array', () => {
      const result = templateMetadataSchema.safeParse({
        ...VALID_METADATA,
        useCases: [],
      });
      // test-review:accept tobe_true — Zod safeParse result success guard; structural schema contract assertion
      expect(result.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    });

    it('parses metadata with empty patterns array', () => {
      const result = templateMetadataSchema.safeParse({
        ...VALID_METADATA,
        patterns: [],
      });
      // test-review:accept tobe_true — Zod safeParse result success guard; structural schema contract assertion
      expect(result.success).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    });
  });

  describe('invalid input', () => {
    it('rejects when flowSummary is missing', () => {
      const { flowSummary: _ignored, ...rest } = VALID_METADATA;
      const result = templateMetadataSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects when useCases is missing', () => {
      const { useCases: _ignored, ...rest } = VALID_METADATA;
      const result = templateMetadataSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects when patterns is missing', () => {
      const { patterns: _ignored, ...rest } = VALID_METADATA;
      const result = templateMetadataSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it('rejects when a useCase entry is missing title', () => {
      const result = templateMetadataSchema.safeParse({
        ...VALID_METADATA,
        useCases: [{ scenario: 'Missing title here.' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects when a pattern entry has a non-number number field', () => {
      const result = templateMetadataSchema.safeParse({
        ...VALID_METADATA,
        patterns: [{ number: 'one', name: 'Chain of Thought' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects null entirely', () => {
      expect(templateMetadataSchema.safeParse(null).success).toBe(false);
    });

    it('rejects a plain string', () => {
      expect(templateMetadataSchema.safeParse('not-metadata').success).toBe(false);
    });
  });
});

describe('toTemplateItem', () => {
  describe('passthrough fields', () => {
    it('preserves slug, name, description, patternsUsed, and isTemplate', () => {
      const workflow = makeWorkflow();
      const result = toTemplateItem(workflow);

      expect(result.slug).toBe('tpl-customer-support');
      expect(result.name).toBe('Customer Support');
      expect(result.description).toBe('Multi-channel support automation');
      expect(result.patternsUsed).toEqual([1, 5]);
      // test-review:accept tobe_true — passthrough field check: isTemplate is explicitly set to true in the input fixture and verified as-is; structural, not a degenerate "operation succeeded" check
      expect(result.isTemplate).toBe(true); // test-review:accept tobe_true — structural boolean/predicate assertion;
    });
  });

  describe('workflowDefinition mapping', () => {
    it('uses the parsed workflowDefinition when the input is valid', () => {
      const workflow = makeWorkflow();
      const result = toTemplateItem(workflow);

      expect(result.workflowDefinition.entryStepId).toBe('step-1');
      expect(result.workflowDefinition.errorStrategy).toBe('fail');
    });

    it('falls back to empty definition when workflowDefinition is null', () => {
      const result = toTemplateItem(makeWorkflow({ workflowDefinition: null }));

      expect(result.workflowDefinition.steps).toEqual([]);
      expect(result.workflowDefinition.entryStepId).toBe('');
      expect(result.workflowDefinition.errorStrategy).toBe('fail');
    });

    it('falls back to empty definition when workflowDefinition is a string', () => {
      const result = toTemplateItem(makeWorkflow({ workflowDefinition: 'not-valid' }));

      expect(result.workflowDefinition.steps).toEqual([]);
      expect(result.workflowDefinition.entryStepId).toBe('');
    });

    it('falls back to empty definition when workflowDefinition is an empty object', () => {
      const result = toTemplateItem(makeWorkflow({ workflowDefinition: {} }));

      expect(result.workflowDefinition.steps).toEqual([]);
      expect(result.workflowDefinition.entryStepId).toBe('');
    });
  });

  describe('metadata mapping', () => {
    it('uses parsed metadata when the input is valid', () => {
      const result = toTemplateItem(makeWorkflow());

      expect(result.metadata).not.toBeNull();
      expect(result.metadata?.flowSummary).toBe(VALID_METADATA.flowSummary);
      expect(result.metadata?.patterns).toHaveLength(2);
    });

    it('returns null for metadata when the input is null', () => {
      const result = toTemplateItem(makeWorkflow({ metadata: null }));
      expect(result.metadata).toBeNull();
    });

    it('returns null for metadata when the input is a plain string', () => {
      const result = toTemplateItem(makeWorkflow({ metadata: 'not-metadata' }));
      expect(result.metadata).toBeNull();
    });

    it('returns null for metadata when required fields are missing', () => {
      const result = toTemplateItem(makeWorkflow({ metadata: { flowSummary: 'Only this field' } }));
      expect(result.metadata).toBeNull();
    });

    it('returns null for metadata when the input is an empty object', () => {
      const result = toTemplateItem(makeWorkflow({ metadata: {} }));
      expect(result.metadata).toBeNull();
    });
  });

  describe('combined valid workflow', () => {
    it('returns a complete TemplateItem with all fields populated', () => {
      const result = toTemplateItem(makeWorkflow());

      expect(result).toMatchObject({
        slug: 'tpl-customer-support',
        name: 'Customer Support',
        description: 'Multi-channel support automation',
        patternsUsed: [1, 5],
        isTemplate: true,
      });
      expect(result.metadata).not.toBeNull();
      expect(result.workflowDefinition).toBeDefined();
    });
  });
});
