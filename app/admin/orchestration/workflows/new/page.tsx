import type { Metadata } from 'next';

import { WorkflowBuilder } from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import type { WorkflowDefinition } from '@/types/orchestration';

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
  let initialDefinition: WorkflowDefinition | undefined;

  if (params.definition) {
    try {
      const parsed: unknown = JSON.parse(decodeURIComponent(params.definition));
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        'steps' in parsed &&
        Array.isArray((parsed as Record<string, unknown>).steps)
      ) {
        initialDefinition = parsed as WorkflowDefinition;
      }
    } catch {
      // Invalid definition param — fall through to empty builder
    }
  }

  return <WorkflowBuilder mode="create" initialDefinition={initialDefinition} />;
}
