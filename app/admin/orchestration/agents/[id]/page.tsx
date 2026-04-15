import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { AgentForm, type ModelOption } from '@/components/admin/orchestration/agent-form';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getAvailableModels } from '@/lib/orchestration/llm/model-registry';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';

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

export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let agent, providers, models: ModelOption[] | null;
  try {
    [agent, providers, models] = await Promise.all([
      prisma.aiAgent.findUnique({ where: { id } }),
      prisma.aiProviderConfig
        .findMany({ orderBy: { createdAt: 'desc' } })
        .then((rows) =>
          rows.map((r) => ({ ...r, apiKeyPresent: isApiKeyEnvVarSet(r.apiKeyEnvVar) }))
        ),
      Promise.resolve(getAvailableModels()),
    ]);
  } catch (err) {
    logger.error('edit agent page: fetch failed', err, { id });
    agent = null;
    providers = null;
    models = null;
  }

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
