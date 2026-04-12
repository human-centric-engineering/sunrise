import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { WorkflowBuilder } from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AiWorkflow } from '@/types/prisma';

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
async function getWorkflow(id: string): Promise<AiWorkflow | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.workflowById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<AiWorkflow>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('edit workflow page: fetch failed', err, { id });
    return null;
  }
}

export default async function EditWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workflow = await getWorkflow(id);
  if (!workflow) notFound();

  return <WorkflowBuilder mode="edit" workflow={workflow} />;
}
