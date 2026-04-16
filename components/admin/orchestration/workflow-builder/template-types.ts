/**
 * UI-facing template types.
 *
 * `TemplateItem` is the shape components work with — derived from
 * `AiWorkflow` rows returned by the workflows API. The `metadata`
 * JSON column holds `WorkflowTemplateMetadata` (flowSummary, useCases,
 * patterns) populated by the 004 seed unit.
 */

import type { WorkflowDefinition, WorkflowTemplateMetadata } from '@/types/orchestration';

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
  return {
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    workflowDefinition: workflow.workflowDefinition as WorkflowDefinition,
    patternsUsed: workflow.patternsUsed,
    isTemplate: workflow.isTemplate,
    metadata: (workflow.metadata as WorkflowTemplateMetadata) ?? null,
  };
}
