import type { Metadata } from 'next';
import Link from 'next/link';

import {
  TriggerForm,
  type AgentOption,
  type WorkflowOption,
} from '@/components/admin/orchestration/trigger-form';
import { API } from '@/lib/api/endpoints';
import { getBaseUrl, parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'New Inbound Trigger · AI Orchestration',
};

async function getWorkflows(): Promise<WorkflowOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.WORKFLOWS}?page=1&limit=200`);
    if (!res.ok) return [];
    const body = await parseApiResponse<WorkflowOption[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('trigger new: workflows fetch failed', err);
    return [];
  }
}

async function getAgents(): Promise<AgentOption[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.AGENTS}?page=1&limit=200`);
    if (!res.ok) return [];
    const body = await parseApiResponse<AgentOption[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('trigger new: agents fetch failed', err);
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

export default async function NewTriggerPage() {
  const [workflows, agents, enabledChannels] = await Promise.all([
    getWorkflows(),
    getAgents(),
    getEnabledChannels(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/orchestration/triggers"
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Triggers
        </Link>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">New trigger</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Configure how an external system fires a workflow.
        </p>
      </div>

      {workflows.length === 0 ? (
        <div className="bg-card rounded-lg border p-6 text-sm">
          You need at least one workflow before you can create a trigger.{' '}
          <Link href="/admin/orchestration/workflows/new" className="text-primary hover:underline">
            Create one →
          </Link>
        </div>
      ) : (
        <TriggerForm
          mode="create"
          workflows={workflows}
          agents={agents}
          enabledChannels={enabledChannels}
          baseUrl={getBaseUrl()}
        />
      )}
    </div>
  );
}
