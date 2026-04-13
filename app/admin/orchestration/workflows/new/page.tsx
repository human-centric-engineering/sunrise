import type { Metadata } from 'next';

import { WorkflowBuilder } from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

export const metadata: Metadata = {
  title: 'New workflow · AI Orchestration',
  description: 'Design a new AI workflow from pattern blocks.',
};

/**
 * Admin — New workflow builder page.
 *
 * Renders an empty builder, or pre-populates from a `?definition=`
 * query parameter (URL-encoded JSON WorkflowDefinition). The advisor
 * chatbot uses this to hand off recommended workflow definitions.
 */
export default async function NewWorkflowPage({
  searchParams,
}: {
  searchParams: Promise<{ definition?: string }>;
}) {
  const params = await searchParams;
  let initialDefinition: typeof workflowDefinitionSchema._output | undefined;

  if (params.definition) {
    try {
      const parsed: unknown = JSON.parse(decodeURIComponent(params.definition));
      const result = workflowDefinitionSchema.safeParse(parsed);
      if (result.success) {
        initialDefinition = result.data;
      }
    } catch {
      // Invalid definition param — fall through to empty builder
    }
  }

  return <WorkflowBuilder mode="create" initialDefinition={initialDefinition} />;
}
