import type { Metadata } from 'next';

import {
  WorkflowBuilder,
  type WorkflowBuilderProps,
} from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import type {
  AgentOption,
  CapabilityOption,
} from '@/components/admin/orchestration/workflow-builder/block-editors';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { z } from 'zod';

/**
 * Templates fetched from the workflows list endpoint now carry their
 * definition inside `publishedVersion.snapshot` rather than a top-level
 * `workflowDefinition` column. The schema flattens that back to the shape
 * the builder expects.
 */
const templateItemSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    publishedVersion: z.object({ snapshot: z.unknown() }).nullable(),
    patternsUsed: z.array(z.number()),
    isTemplate: z.boolean(),
    metadata: z.unknown(),
  })
  .transform((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    workflowDefinition: row.publishedVersion?.snapshot,
    patternsUsed: row.patternsUsed,
    isTemplate: row.isTemplate,
    metadata: row.metadata,
  }));

const templateListSchema = z.array(templateItemSchema);

export const metadata: Metadata = {
  title: 'New workflow · AI Orchestration',
  description: 'Design a new AI workflow from pattern blocks.',
};

async function getCapabilities(): Promise<CapabilityOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.CAPABILITIES}?limit=100`);
    if (!res.ok) return [];
    const body = await parseApiResponse<CapabilityOption[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('new workflow page: capabilities fetch failed', err);
    return [];
  }
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&isActive=true`);
    if (!res.ok) return [];
    const body =
      await parseApiResponse<Array<{ slug: string; name: string; description: string | null }>>(
        res
      );
    if (!body.success) return [];
    return body.data.map((a) => ({ slug: a.slug, name: a.name, description: a.description }));
  } catch (err) {
    logger.error('new workflow page: agents fetch failed', err);
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
    logger.error('new workflow page: templates fetch failed', err);
    return [];
  }
}

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

  const [capabilities, agents, templates] = await Promise.all([
    getCapabilities(),
    getAgents(),
    getTemplates(),
  ]);

  return (
    <WorkflowBuilder
      mode="create"
      initialDefinition={initialDefinition}
      initialCapabilities={capabilities}
      initialAgents={agents}
      initialTemplates={templates}
    />
  );
}
