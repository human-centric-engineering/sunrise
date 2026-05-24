import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  TriggerForm,
  type AgentOption,
  type WorkflowOption,
  type TriggerFormInitial,
} from '@/components/admin/orchestration/trigger-form';
import { API } from '@/lib/api/endpoints';
import { getBaseUrl, parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

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

async function getTrigger(id: string): Promise<ApiTrigger | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.triggerById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<ApiTrigger>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('trigger edit: fetch failed', err);
    return null;
  }
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=200`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AgentOption[]>(res);
    return body.success ? body.data : [];
  } catch {
    return [];
  }
}

async function getEnabledChannels(): Promise<string[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.TRIGGERS}?page=1&limit=1`);
    if (!res.ok) return [];
    const body = await parseApiResponse<unknown>(res);
    if (
      body.success &&
      body.meta &&
      typeof body.meta === 'object' &&
      'enabledChannels' in body.meta
    ) {
      return (body.meta as { enabledChannels: string[] }).enabledChannels ?? [];
    }
    return [];
  } catch {
    return [];
  }
}

export default async function EditTriggerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [trigger, agents, enabledChannels] = await Promise.all([
    getTrigger(id),
    getAgents(),
    getEnabledChannels(),
  ]);

  if (!trigger) notFound();

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
        baseUrl={getBaseUrl()}
      />
    </div>
  );
}
