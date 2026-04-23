import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AgentForm } from '@/components/admin/orchestration/agent-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { getModels, getProviders } from '@/lib/orchestration/prefetch-helpers';
import type { AiAgent } from '@/types/prisma';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const agent = await getAgent(id);
  return {
    title: agent ? `Edit ${agent.name} · AI Orchestration` : 'Edit agent · AI Orchestration',
    description: 'Edit an existing AI agent.',
  };
}

/**
 * Admin — Edit agent page (Phase 4 Session 4.2).
 *
 * Server component shell. Fetches the agent, provider list, and model
 * registry in parallel. Missing agent → `notFound()`. Provider/model
 * fetch failures are tolerated — the form renders with text-input
 * fallbacks.
 */

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
