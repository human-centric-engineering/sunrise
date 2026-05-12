import type { Metadata } from 'next';
import Link from 'next/link';

import type { ProviderRow } from '@/components/admin/orchestration/providers-list';
import type { ModelRow } from '@/components/admin/orchestration/provider-models-matrix';
import { ProvidersTabs } from '@/components/admin/orchestration/providers-tabs';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { KNOWN_PROVIDERS, detectApiKeyEnvVar } from '@/lib/orchestration/llm/known-providers';

export const metadata: Metadata = {
  title: 'Providers · AI Orchestration',
  description: 'LLM provider configurations, model matrix, and selection heuristic.',
};

async function getProviders(): Promise<ProviderRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=50`);
    if (!res.ok) return [];
    const body = await parseApiResponse<ProviderRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('providers page: provider fetch failed', err);
    return [];
  }
}

async function getModels(): Promise<ModelRow[]> {
  try {
    const res = await serverFetch(
      `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?page=1&limit=100&isActive=true`
    );
    if (!res.ok) return [];
    const body = await parseApiResponse<ModelRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('providers page: model fetch failed', err);
    return [];
  }
}

export default async function ProvidersListPage() {
  const [providers, models] = await Promise.all([getProviders(), getModels()]);

  // Server-side env scan. Hide the "Add provider" CTAs when no hosted
  // provider has a matching env var, since the resulting config row
  // can't authenticate at runtime — operators are pushed back to the
  // amber banner's "set env var and restart" guidance instead. Ollama
  // (isLocal) doesn't count; if the operator wants to add it they can
  // still use the manual link in the banner.
  const hasAnyEnvKey = KNOWN_PROVIDERS.filter((p) => !p.isLocal).some(
    (p) => detectApiKeyEnvVar(p) !== null
  );

  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <span>Providers</span>
        </nav>
        <h1 className="text-2xl font-semibold">
          Providers{' '}
          <FieldHelp title="What are providers?" contentClassName="w-96 max-h-80 overflow-y-auto">
            <p>
              A provider is an LLM backend — Anthropic (Claude), OpenAI, a local Ollama instance, or
              any OpenAI-compatible API. It stores the base URL and model catalogue. API keys are
              referenced by environment variable name, never displayed in the UI.
            </p>
            <p className="text-foreground mt-2 font-medium">Configuration tab</p>
            <p>
              See configured providers, check API-key status, browse available models, and add new
              backends.
            </p>
            <p className="text-foreground mt-2 font-medium">Model Matrix tab</p>
            <p>
              Per-model analysis of every LLM and embedding model in the landscape — tier
              classification, capabilities, and selection heuristic.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          LLM backend configuration and per-model analysis matrix.
        </p>
      </header>

      <ProvidersTabs
        initialProviders={providers}
        initialModels={models}
        hasAnyEnvKey={hasAnyEnvKey}
      />
    </div>
  );
}
