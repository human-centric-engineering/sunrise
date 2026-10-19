import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ProviderForm,
  type ProviderRowWithStatus,
} from '@/components/admin/orchestration/provider-form';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';

export const metadata: Metadata = {
  title: 'Edit provider · AI Orchestration',
  description: 'Edit an existing LLM provider configuration.',
};

export default async function EditProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A 404 is a missing provider; any other failure reaches the error boundary.
  const { data: provider } = await requireServerData<ProviderRowWithStatus>(
    API.ADMIN.ORCHESTRATION.providerById(id),
    { notFound: true }
  );

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
        <span>{provider.name}</span>
      </nav>

      <SharedSettingsReadOnlyNotice />

      <ProviderForm mode="edit" provider={provider} />
    </div>
  );
}
