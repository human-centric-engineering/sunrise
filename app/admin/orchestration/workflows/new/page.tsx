import type { Metadata } from 'next';

import {
  WorkflowBuilder,
  type WorkflowBuilderProps,
} from '@/components/admin/orchestration/workflow-builder/workflow-builder';
import type {
  AgentOption,
  CapabilityOption,
} from '@/components/admin/orchestration/workflow-builder/block-editors';
import { templateCatalogueSchema } from '@/components/admin/orchestration/workflow-builder/template-types';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

export const metadata: Metadata = {
  title: 'New workflow · AI Orchestration',
  description: 'Design a new AI workflow from pattern blocks.',
};

/**
 * The editor's option lists. None is the page's reason to exist: the canvas
 * still works without them, so each is loaded with `loadServerData` and is
 * `null` when it failed. The page then shows `<LoadFailedNotice>` above the
 * builder, so an empty capability, agent or template picker is not taken as
 * "there are none" (#518). The builder also retries capabilities and agents
 * client-side when it is handed an empty list.
 */
async function getCapabilities(): Promise<CapabilityOption[] | null> {
  const result = await loadServerData<CapabilityOption[]>(
    `${API.ADMIN.ORCHESTRATION.CAPABILITIES}?limit=100`
  );
  return result.ok ? result.data : null;
}

async function getAgents(): Promise<AgentOption[] | null> {
  const result = await loadServerData<
    Array<{ slug: string; name: string; description: string | null }>
  >(`${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&isActive=true`);
  if (!result.ok) return null;
  return result.data.map((a) => ({ slug: a.slug, name: a.name, description: a.description }));
}

async function getTemplates(): Promise<WorkflowBuilderProps['initialTemplates'] | null> {
  const result = await loadServerData<unknown[]>(API.ADMIN.ORCHESTRATION.WORKFLOW_TEMPLATES);
  if (!result.ok) return null;
  const parsed = templateCatalogueSchema.safeParse(result.data);
  if (!parsed.success) {
    logger.warn('new workflow page: templates response did not parse', {
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}

/** A notice for each option list that could not be loaded. */
function OptionLoadFailures({
  capabilities,
  agents,
  templates,
}: {
  capabilities: unknown;
  agents: unknown;
  templates: unknown;
}) {
  return (
    <>
      {capabilities === null && <LoadFailedNotice what="capabilities for Tool Call steps" />}
      {agents === null && <LoadFailedNotice what="agents for Orchestrator steps" />}
      {templates === null && <LoadFailedNotice what="workflow templates" />}
    </>
  );
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
    <>
      <OptionLoadFailures capabilities={capabilities} agents={agents} templates={templates} />
      <WorkflowBuilder
        mode="create"
        initialDefinition={initialDefinition}
        initialCapabilities={capabilities ?? []}
        initialAgents={agents ?? []}
        initialTemplates={templates ?? []}
      />
    </>
  );
}
