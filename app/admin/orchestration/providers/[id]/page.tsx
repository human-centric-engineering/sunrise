import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  ProviderForm,
  type ProviderRowWithStatus,
} from '@/components/admin/orchestration/provider-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Edit provider · AI Orchestration',
  description: 'Edit an existing LLM provider configuration.',
};

async function getProvider(id: string): Promise<ProviderRowWithStatus | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.providerById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<ProviderRowWithStatus>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('edit provider page: provider fetch failed', err, { id });
    return null;
  }
}

export default async function EditProviderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const provider = await getProvider(id);
  if (!provider) notFound();

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

      <ProviderForm mode="edit" provider={provider} />
    </div>
  );
}
