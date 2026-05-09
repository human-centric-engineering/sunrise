import type { Metadata } from 'next';
import Link from 'next/link';
import { Sparkles } from 'lucide-react';

import { ProviderForm } from '@/components/admin/orchestration/provider-form';
import { Card, CardContent } from '@/components/ui/card';
import { getSetupState } from '@/lib/orchestration/setup-state';

export const metadata: Metadata = {
  title: 'New provider · AI Orchestration',
  description: 'Configure a new LLM provider.',
};

export default async function NewProviderPage() {
  // Only show the getting-started hint when this is the operator's
  // first provider — once they've configured one, they don't need
  // pointing back at the wizard.
  const { hasProvider } = await getSetupState();

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

      {!hasProvider && (
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
