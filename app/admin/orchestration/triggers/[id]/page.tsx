import type { Metadata } from 'next';
import Link from 'next/link';

import {
  TriggerForm,
  type AgentOption,
  type WorkflowOption,
  type TriggerFormInitial,
} from '@/components/admin/orchestration/trigger-form';
import { API } from '@/lib/api/endpoints';
import { getPublicUrl } from '@/lib/api/server-fetch';
import { requireAllServerData, requireServerData } from '@/lib/api/server-load';
import { parseEnabledChannelsFromMeta } from '@/lib/orchestration/admin/trigger-meta';

export const metadata: Metadata = {
  title: 'Edit Trigger · AI Orchestration',
};

interface ApiTrigger {
  id: string;
  channel: string;
  name: string;
  workflowId: string;
  metadata: Record<string, unknown> | null;
  isEnabled: boolean;
  hasSigningSecret: boolean;
  lastFiredAt: string | null;
  workflow: { id: string; name: string; slug: string; isActive: boolean };
}

/** A 404 is a missing trigger; any other failure reaches the error boundary (#518). */
async function getTrigger(id: string): Promise<ApiTrigger> {
  const { data } = await requireServerData<ApiTrigger>(API.ADMIN.ORCHESTRATION.triggerById(id), {
    notFound: true,
  });
  return data;
}

/**
 * The form's options are required as well: an empty channel list flags the
 * trigger's adapter as unregistered, and an empty agent list hides the
 * conversation agent it is set to. A failed load throws (#518). The agents
 * are read across every page for the same reason: past 100, a single page
 * could leave out the trigger's own agent.
 */
async function getAgents(): Promise<AgentOption[]> {
  return requireAllServerData<AgentOption>(API.ADMIN.ORCHESTRATION.AGENTS);
}

async function getEnabledChannels(): Promise<string[]> {
  const { meta } = await requireServerData<unknown>(
    `${API.ADMIN.ORCHESTRATION.TRIGGERS}?page=1&limit=1`
  );
  return parseEnabledChannelsFromMeta(meta);
}

export default async function EditTriggerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [trigger, agents, enabledChannels] = await Promise.all([
    getTrigger(id),
    getAgents(),
    getEnabledChannels(),
  ]);

  const initial: TriggerFormInitial = {
    id: trigger.id,
    channel: trigger.channel,
    name: trigger.name,
    workflowId: trigger.workflowId,
    metadata: trigger.metadata ?? {},
    isEnabled: trigger.isEnabled,
    hasSigningSecret: trigger.hasSigningSecret,
  };

  const workflows: WorkflowOption[] = [trigger.workflow];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/orchestration/triggers"
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Triggers
        </Link>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Edit trigger</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Channel and workflow cannot be changed after creation. Delete and recreate if you need to
          move this trigger to a different channel or workflow.
        </p>
      </div>

      <TriggerForm
        mode="edit"
        initial={initial}
        workflows={workflows}
        agents={agents}
        enabledChannels={enabledChannels}
        baseUrl={getPublicUrl()}
      />
    </div>
  );
}
