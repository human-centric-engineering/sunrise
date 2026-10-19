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
import { WorkflowSchedulesTab } from '@/components/admin/orchestration/workflow-schedules-tab';
import { LoadFailedNotice } from '@/components/admin/load-failed-notice';
import { API } from '@/lib/api/endpoints';
import { loadServerData, requireServerData } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import type { AiWorkflowWithVersion } from '@/types/orchestration';

export const metadata: Metadata = {
  title: 'Edit workflow · AI Orchestration',
  description: 'Edit an existing AI workflow.',
};

/**
 * Admin — Edit workflow builder page (Phase 5 Session 5.1a).
 *
 * Fetches the workflow by id and hydrates the builder. A 404 renders the
 * not-found page; any other failure throws to the admin error boundary
 * rather than reading as a missing workflow (#518). The builder reads
 * `draftDefinition` (or falls back to `publishedVersion.snapshot`) and
 * lays the DAG out via the pure-TS `workflowDefinitionToFlow` mapper.
 */
async function getWorkflow(id: string): Promise<AiWorkflowWithVersion> {
  const { data } = await requireServerData<AiWorkflowWithVersion>(
    API.ADMIN.ORCHESTRATION.workflowById(id),
    { notFound: true }
  );
  return data;
}

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
    logger.warn('edit workflow page: templates response did not parse', {
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

export default async function EditWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [workflow, capabilities, agents, templates] = await Promise.all([
    getWorkflow(id),
    getCapabilities(),
    getAgents(),
    getTemplates(),
  ]);

  return (
    <div className="space-y-8">
      <OptionLoadFailures capabilities={capabilities} agents={agents} templates={templates} />
      <WorkflowBuilder
        mode="edit"
        workflow={workflow}
        initialCapabilities={capabilities ?? []}
        initialAgents={agents ?? []}
        initialTemplates={templates ?? []}
      />
      <hr />
      <WorkflowSchedulesTab workflowId={workflow.id} />
    </div>
  );
}
