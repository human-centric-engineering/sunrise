import type { Metadata } from 'next';
import Link from 'next/link';

import { ProviderForm } from '@/components/admin/orchestration/provider-form';

export const metadata: Metadata = {
  title: 'New provider · AI Orchestration',
  description: 'Configure a new LLM provider.',
};

export default function NewProviderPage() {
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

      <ProviderForm mode="create" />
    </div>
  );
}
