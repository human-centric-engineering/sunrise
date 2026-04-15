import type { Metadata } from 'next';
import Link from 'next/link';

import { ProvidersList, type ProviderRow } from '@/components/admin/orchestration/providers-list';
import { FieldHelp } from '@/components/ui/field-help';
import { prisma } from '@/lib/db/client';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Providers · AI Orchestration',
  description: 'LLM provider configurations — status, keys, and model catalogues.',
};

export default async function ProvidersListPage() {
  let providers: ProviderRow[];
  try {
    const rows = await prisma.aiProviderConfig.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    providers = rows.map((r) => ({ ...r, apiKeyPresent: isApiKeyEnvVarSet(r.apiKeyEnvVar) }));
  } catch (err) {
    logger.error('providers list page: initial fetch failed', err);
    providers = [];
  }

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
