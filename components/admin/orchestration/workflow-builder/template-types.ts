/**
 * UI-facing template types.
 *
 * `TemplateItem` is the shape components work with — derived from
 * `AiWorkflow` rows returned by the workflows API. The `metadata`
 * JSON column holds `WorkflowTemplateMetadata` (flowSummary, useCases,
 * patterns) populated by the 004 seed unit.
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
 * A template item for the builder UI. Mapped from an `AiWorkflow` row
 * where `isTemplate === true`.
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
 * Map an `AiWorkflow` row (from the API) to a `TemplateItem`.
 *
 * The `workflowDefinition` and `metadata` columns are typed as `Json`
 * in Prisma, so they arrive as `unknown`. This function narrows them
 * to the expected shapes.
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
    workflowDefinition: defResult.success ? (defResult.data as WorkflowDefinition) : emptyDef,
    patternsUsed: workflow.patternsUsed,
    isTemplate: workflow.isTemplate,
    metadata: metaResult.success ? (metaResult.data as WorkflowTemplateMetadata) : null,
  };
}
