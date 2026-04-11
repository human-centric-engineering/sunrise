import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AgentForm, type ModelOption } from '@/components/admin/orchestration/agent-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AiAgent, AiProviderConfig } from '@/types/prisma';

export const metadata: Metadata = {
  title: 'Edit agent · AI Orchestration',
  description: 'Edit an existing AI agent.',
};

/**
 * Admin — Edit agent page (Phase 4 Session 4.2).
 *
 * Server component shell. Fetches the agent, provider list, and model
 * registry in parallel. Missing agent → `notFound()`. Provider/model
 * fetch failures are tolerated — the form renders with text-input
 * fallbacks.
 */

interface ModelsResponse {
  models: Array<{ provider: string; id: string; tier?: string }>;
}

async function getAgent(id: string): Promise<AiAgent | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.agentById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<AiAgent>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('edit agent page: agent fetch failed', err, { id });
    return null;
  }
}

async function getProviders(): Promise<AiProviderConfig[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.PROVIDERS);
    if (!res.ok) return null;
    const body = await parseApiResponse<AiProviderConfig[]>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('edit agent page: provider fetch failed', err);
    return null;
  }
}

async function getModels(): Promise<ModelOption[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MODELS);
    if (!res.ok) return null;
    const body = await parseApiResponse<ModelsResponse | ModelOption[]>(res);
    if (!body.success) return null;
    const data = body.data;
    if (Array.isArray(data)) return data;
    if (data && 'models' in data && Array.isArray(data.models)) return data.models;
    return null;
  } catch (err) {
    logger.error('edit agent page: model registry fetch failed', err);
    return null;
  }
}

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [agent, providers, models] = await Promise.all([getAgent(id), getProviders(), getModels()]);

  if (!agent) notFound();

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/agents" className="hover:underline">
          Agents
        </Link>
        {' / '}
        <span>{agent.name}</span>
      </nav>

      <AgentForm mode="edit" agent={agent} providers={providers} models={models} />
    </div>
  );
}
