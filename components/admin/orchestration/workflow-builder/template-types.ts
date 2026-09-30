/**
 * UI-facing template types.
 *
 * `TemplateItem` is the shape components work with — derived from the
 * entries `GET /workflows/templates` returns: the built-in templates,
 * served from code, and the org's own template rows. `metadata` holds
 * `WorkflowTemplateMetadata` (flowSummary, useCases, patterns).
 */

import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import type { WorkflowDefinition, WorkflowTemplateMetadata } from '@/types/orchestration';
import { z } from 'zod';

/** Runtime validator for the `metadata` JSON column on template workflows. */
export const templateMetadataSchema = z.object({
  flowSummary: z.string(),
  useCases: z.array(z.object({ title: z.string(), scenario: z.string() })),
  patterns: z.array(z.object({ number: z.number(), name: z.string() })),
});

/**
 * The response of `GET /workflows/templates`, flattened to the shape the
 * builder's `initialTemplates` prop takes. Every entry is a template, so
 * `isTemplate` is always true. `workflowDefinition` and `metadata` stay
 * `unknown` here; `toTemplateItem` validates them.
 */
export const templateCatalogueSchema = z.array(
  z
    .object({
      source: z.enum(['builtin', 'custom']),
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      workflowDefinition: z.unknown(),
      patternsUsed: z.array(z.number()),
      metadata: z.unknown(),
    })
    .transform((entry) => ({
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      workflowDefinition: entry.workflowDefinition,
      patternsUsed: entry.patternsUsed,
      isTemplate: true,
      metadata: entry.metadata,
    }))
);

/**
 * A template item for the builder UI, mapped from one entry of
 * `templateCatalogueSchema`.
 */
export interface TemplateItem {
  slug: string;
  name: string;
  description: string;
  workflowDefinition: WorkflowDefinition;
  patternsUsed: number[];
  isTemplate: boolean;
  metadata: WorkflowTemplateMetadata | null;
}

/**
 * Map a template entry (from the API) to a `TemplateItem`.
 *
 * A custom template's `workflowDefinition` and `metadata` come from `Json`
 * columns, so they arrive as `unknown`. This function narrows them to the
 * expected shapes.
 */
export function toTemplateItem(workflow: {
  slug: string;
  name: string;
  description: string;
  workflowDefinition: unknown;
  patternsUsed: number[];
  isTemplate: boolean;
  metadata: unknown;
}): TemplateItem {
  const defResult = workflowDefinitionSchema.safeParse(workflow.workflowDefinition);
  const metaResult = templateMetadataSchema.safeParse(workflow.metadata);

  const emptyDef: WorkflowDefinition = { steps: [], entryStepId: '', errorStrategy: 'fail' };

  return {
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    workflowDefinition: defResult.success ? defResult.data : emptyDef,
    patternsUsed: workflow.patternsUsed,
    isTemplate: workflow.isTemplate,
    metadata: metaResult.success ? metaResult.data : null,
  };
}
