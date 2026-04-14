import type { Metadata } from 'next';
import Link from 'next/link';

import { ProvidersList, type ProviderRow } from '@/components/admin/orchestration/providers-list';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Providers · AI Orchestration',
  description: 'LLM provider configurations — status, keys, and model catalogues.',
};

/**
 * Admin — Providers list page (Phase 4 Session 4.3).
 *
 * Thin async server shell. Fetches the provider list (every row
 * hydrated with `apiKeyPresent: boolean` on the backend) and hands
 * it to `<ProvidersList>`. Fetch failures never throw — the list
 * renders empty so the page remains usable.
 */
async function getProviders(): Promise<ProviderRow[]> {
  try {
    const res = await serverFetch(`${API.ADMIN.ORCHESTRATION.PROVIDERS}?page=1&limit=50`);
    if (!res.ok) return [];
    const body = await parseApiResponse<ProviderRow[]>(res);
    return body.success ? body.data : [];
  } catch (err) {
    logger.error('providers list page: initial fetch failed', err);
    return [];
  }
}

export default async function ProvidersListPage() {
  const providers = await getProviders();

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
            <p className="text-foreground mt-2 font-medium">How it works</p>
            <p>
              When an agent sends a prompt, the runtime looks up its provider, reads the API key
              from the server environment, and makes the LLM call. You can run multiple providers
              and assign different ones to different agents — e.g. a fast model for triage, a
              powerful model for analysis.
            </p>
            <p className="text-foreground mt-2 font-medium">This page</p>
            <p>
              See configured providers, check API-key status, browse available models, and add new
              backends.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          LLM backends your agents can call. API keys live in environment variables on the server —
          this UI only references them by name.
        </p>
      </header>

      <ProvidersList initialProviders={providers} />
    </div>
  );
}
