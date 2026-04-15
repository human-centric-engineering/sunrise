import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { WorkflowBuilder } from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Edit workflow · AI Orchestration',
  description: 'Edit an existing AI workflow.',
};

/**
 * Admin — Edit workflow builder page (Phase 5 Session 5.1a).
 *
 * Fetches the workflow by id and hydrates the builder. A missing or
 * failed fetch produces a 404 via `notFound()`. The builder reads the
 * `workflowDefinition` JSON and lays the DAG out via the pure-TS
 * `workflowDefinitionToFlow` mapper.
 */
export default async function EditWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let workflow;
  try {
    workflow = await prisma.aiWorkflow.findUnique({ where: { id } });
  } catch (err) {
    logger.error('edit workflow page: fetch failed', err, { id });
    workflow = null;
  }

  if (!workflow) notFound();

  return <WorkflowBuilder mode="edit" workflow={workflow} />;
}
