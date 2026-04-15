import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentForm, type ModelOption } from '@/components/admin/orchestration/agent-form';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getAvailableModels } from '@/lib/orchestration/llm/model-registry';

export const metadata: Metadata = {
  title: 'New agent · AI Orchestration',
  description: 'Create a new AI agent.',
};

/**
 * Admin — New agent page (Phase 4 Session 4.2).
 *
 * Thin server shell that prefetches the provider list and the aggregated
 * model registry so the AgentForm's Model tab hydrates with no loading
 * flicker. Both fetches are null-safe — on failure the form falls back to
 * free-text inputs with a warning banner, never throwing.
 */

export default async function NewAgentPage() {
  let providers, models: ModelOption[] | null;
  try {
    [providers, models] = await Promise.all([
      prisma.aiProviderConfig.findMany({ orderBy: { createdAt: 'desc' } }),
      Promise.resolve(getAvailableModels()),
    ]);
  } catch (err) {
    logger.error('new agent page: fetch failed', err);
    providers = null;
    models = null;
  }

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
        <span>New</span>
      </nav>

      <AgentForm mode="create" providers={providers} models={models} />
    </div>
  );
}
