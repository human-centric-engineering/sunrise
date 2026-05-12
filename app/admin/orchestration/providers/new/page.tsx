import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, Sparkles } from 'lucide-react';

import { ProviderForm } from '@/components/admin/orchestration/provider-form';
import { Card, CardContent } from '@/components/ui/card';
import { getSetupState } from '@/lib/orchestration/setup-state';
import { KNOWN_PROVIDERS, detectApiKeyEnvVar } from '@/lib/orchestration/llm/known-providers';

export const metadata: Metadata = {
  title: 'New provider · AI Orchestration',
  description: 'Configure a new LLM provider.',
};

export default async function NewProviderPage() {
  // Only show the getting-started hint when this is the operator's
  // first provider — once they've configured one, they don't need
  // pointing back at the wizard.
  const { hasProvider } = await getSetupState();

  // Server-side env scan. Mirrors `/providers/detect` (same registry,
  // same helper) so the page can warn before the operator fills the
  // form. Hosted providers without a matching env var can't
  // authenticate at runtime — surfacing that up front saves them a
  // confusing 401 later.
  const cloudProviders = KNOWN_PROVIDERS.filter((p) => !p.isLocal);
  const hasAnyEnvKey = cloudProviders.some((p) => detectApiKeyEnvVar(p) !== null);
  const candidateEnvVars = cloudProviders
    .map((p) => ({ name: p.name, envVar: p.apiKeyEnvVars[0] }))
    .filter((c): c is { name: string; envVar: string } => Boolean(c.envVar));

  return (
    <div className="space-y-6">
      <nav className="text-muted-foreground text-xs">
        <Link href="/admin/orchestration" className="hover:underline">
          AI Orchestration
        </Link>
        {' / '}
        <Link href="/admin/orchestration/providers" className="hover:underline">
          Providers
        </Link>
        {' / '}
        <span>New</span>
      </nav>

      {!hasAnyEnvKey && (
        <Card className="border-amber-300 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-900/10">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle
              className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400"
              aria-hidden="true"
            />
            <div className="text-sm">
              <p className="font-medium">No LLM API keys detected in your environment</p>
              <p className="text-muted-foreground mt-1">
                Sunrise reads provider API keys from environment variables at startup — it never
                stores them in the database. Add one of the following to your <code>.env</code> file
                and restart the server before configuring a hosted provider:
              </p>
              <ul className="text-muted-foreground mt-2 space-y-0.5 text-xs">
                {candidateEnvVars.map((c) => (
                  <li key={c.envVar}>
                    <code className="bg-muted/60 rounded px-1 py-0.5">{c.envVar}</code> — {c.name}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-2 text-xs">
                If you&apos;re running Ollama or a self-hosted endpoint that doesn&apos;t need an
                API key, you can ignore this warning and use the form below.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!hasProvider && hasAnyEnvKey && (
        <Card className="border-primary/30 bg-primary/5 dark:bg-primary/10">
          <CardContent className="flex items-start gap-3 p-4">
            <Sparkles className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div className="text-sm">
              <p className="font-medium">First time configuring a provider?</p>
              <p className="text-muted-foreground mt-1">
                The{' '}
                <Link href="/admin/orchestration" className="underline">
                  setup wizard
                </Link>{' '}
                detects API keys you&apos;ve set in <code>.env</code> and configures the matching
                provider in one click — including the base URL, recommended chat model, and
                embedding defaults. Use the form below for custom or self-hosted endpoints.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <ProviderForm mode="create" />
    </div>
  );
}
