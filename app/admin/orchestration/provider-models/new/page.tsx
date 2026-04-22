import type { Metadata } from 'next';
import Link from 'next/link';

import { ProviderModelForm } from '@/components/admin/orchestration/provider-model-form';

export const metadata: Metadata = {
  title: 'New Provider Model · AI Orchestration',
  description: 'Add a new model to the provider selection matrix.',
};

export default function NewProviderModelPage() {
  return (
    <div className="space-y-6">
      <header>
        <nav className="text-muted-foreground mb-1 text-xs">
          <Link href="/admin/orchestration" className="hover:underline">
            AI Orchestration
          </Link>
          {' / '}
          <Link href="/admin/orchestration/providers?tab=models" className="hover:underline">
            Provider Models
          </Link>
          {' / '}
          <span>New</span>
        </nav>
        <h1 className="text-2xl font-semibold">New Provider Model</h1>
        <p className="text-muted-foreground text-sm">
          Add a model to the selection matrix with its characteristics and tier classification.
        </p>
      </header>

      <ProviderModelForm />
    </div>
  );
}
