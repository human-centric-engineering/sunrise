import type { Metadata } from 'next';
import Link from 'next/link';

import { AgentForm, type ModelOption } from '@/components/admin/orchestration/agent-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import type { AiProviderConfig } from '@/types/prisma';

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

interface ModelsResponse {
  models: Array<{ provider: string; id: string; tier?: string }>;
}

async function getProviders(): Promise<AiProviderConfig[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.PROVIDERS);
    if (!res.ok) return null;
    const body = await parseApiResponse<AiProviderConfig[]>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('new agent page: provider fetch failed', err);
    return null;
  }
}

async function getModels(): Promise<ModelOption[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MODELS);
    if (!res.ok) return null;
    const body = await parseApiResponse<ModelsResponse | ModelOption[]>(res);
    if (!body.success) return null;
    // The registry endpoint returns either `{ models: [...] }` or a flat
    // array depending on version — accept both shapes.
    const data = body.data;
    if (Array.isArray(data)) return data;
    if (data && 'models' in data && Array.isArray(data.models)) return data.models;
    return null;
  } catch (err) {
    logger.error('new agent page: model registry fetch failed', err);
    return null;
  }
}

export default async function NewAgentPage() {
  const [providers, models] = await Promise.all([getProviders(), getModels()]);

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
