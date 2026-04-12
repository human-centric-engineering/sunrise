/**
 * Unit Tests: BUILTIN_WORKFLOW_TEMPLATES
 *
 * These tests lock in invariants the rest of the builder relies on:
 *
 *  - Every built-in template passes `validateWorkflow()` (same rules the
 *    backend enforces) so a user can safely load + save a template.
 *  - Every template passes the FE-only `runExtraChecks()` the builder
 *    runs alongside the validator (no `DISCONNECTED_NODE`,
 *    `PARALLEL_WITHOUT_MERGE`, or `MISSING_REQUIRED_CONFIG`).
 *  - `entryStepId` resolves to a real step.
 *  - Every `tool_call` references a real built-in capability slug.
 *  - Every `llm_call` ships with a non-empty prompt.
 *  - Slugs are unique (the seeder upserts on `slug`).
 *
 * @see lib/orchestration/workflows/templates/index.ts
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@/lib/orchestration/workflows/templates';
import { validateWorkflow } from '@/lib/orchestration/workflows/validator';
import {
  runExtraChecks,
  type ExtraCheckError,
} from '@/components/admin/orchestration/workflow-builder/extra-checks';
import { workflowDefinitionToFlow } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

const BUILTIN_CAPABILITY_SLUGS = new Set([
  'search_knowledge_base',
  'get_pattern_detail',
  'estimate_workflow_cost',
]);

describe('BUILTIN_WORKFLOW_TEMPLATES', () => {
  it('exports five built-in templates', () => {
    expect(BUILTIN_WORKFLOW_TEMPLATES).toHaveLength(5);
  });

  it('has unique slugs across all templates', () => {
    const slugs = BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it.each(BUILTIN_WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s passes validateWorkflow() with no errors',
    (_name, template) => {
      const result = validateWorkflow(template.workflowDefinition);
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    }
  );

  it.each(BUILTIN_WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s has an entryStepId that resolves to a real step',
    (_name, template) => {
      const ids = new Set(template.workflowDefinition.steps.map((s) => s.id));
      expect(ids.has(template.workflowDefinition.entryStepId)).toBe(true);
    }
  );

  it.each(BUILTIN_WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s passes runExtraChecks() via the round-tripped canvas shape',
    (_name, template) => {
      // `runExtraChecks` operates on the React Flow nodes/edges the
      // builder actually shows, so round-trip through the mapper first.
      const { nodes, edges } = workflowDefinitionToFlow(template.workflowDefinition);
      const errors: ExtraCheckError[] = runExtraChecks(nodes, edges);
      expect(errors).toEqual([]);
    }
  );

  it.each(BUILTIN_WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s: every llm_call has a non-empty prompt',
    (_name, template) => {
      for (const step of template.workflowDefinition.steps) {
        if (step.type !== 'llm_call') continue;
        const prompt = (step.config as { prompt?: unknown }).prompt;
        expect(typeof prompt).toBe('string');
        expect((prompt as string).trim().length).toBeGreaterThan(0);
      }
    }
  );

  it.each(BUILTIN_WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s: every tool_call references a real built-in capability slug',
    (_name, template) => {
      for (const step of template.workflowDefinition.steps) {
        if (step.type !== 'tool_call') continue;
        const slug = (step.config as { capabilitySlug?: unknown }).capabilitySlug;
        expect(typeof slug).toBe('string');
        expect(BUILTIN_CAPABILITY_SLUGS.has(slug as string)).toBe(true);
      }
    }
  );

  it.each(BUILTIN_WORKFLOW_TEMPLATES.map((t) => [t.name, t] as const))(
    '%s: at least one pattern is declared',
    (_name, template) => {
      expect(template.patterns.length).toBeGreaterThan(0);
    }
  );
});
