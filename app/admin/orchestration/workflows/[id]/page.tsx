import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import {
  WorkflowBuilder,
  type WorkflowBuilderProps,
} from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import type { CapabilityOption } from '@/components/admin/orchestration/workflow-builder/block-editors';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AiWorkflow } from '@/types/prisma';
import { z } from 'zod';

const templateItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  workflowDefinition: z.unknown(),
  patternsUsed: z.array(z.number()),
  isTemplate: z.boolean(),
  metadata: z.unknown(),
});

const templateListSchema = z.array(templateItemSchema);

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

async function getCapabilities(): Promise<CapabilityOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<CapabilityOption[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('edit workflow page: capabilities fetch failed', err);
    return [];
  }
}

async function getTemplates(): Promise<WorkflowBuilderProps['initialTemplates']> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.WORKFLOWS}?isTemplate=true&limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<unknown[]>(res);
    if (!body.success) return [];
    const result = templateListSchema.safeParse(body.data);
    return result.success ? result.data : [];
  } catch (err) {
    logger.error('edit workflow page: templates fetch failed', err);
    return [];
  }
}

export default async function EditWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [workflow, capabilities, templates] = await Promise.all([
    getWorkflow(id),
    getCapabilities(),
    getTemplates(),
  ]);
  if (!workflow) notFound();

  return (
    <WorkflowBuilder
      mode="edit"
      workflow={workflow}
      initialCapabilities={capabilities}
      initialTemplates={templates}
    />
  );
}
