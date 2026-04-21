import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  ProviderModelForm,
  type ProviderModelData,
} from '@/components/admin/orchestration/provider-model-form';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

export const metadata: Metadata = {
  title: 'Edit Provider Model · AI Orchestration',
  description: 'Update provider model characteristics and tier classification.',
};

interface Props {
  params: Promise<{ id: string }>;
}

async function getModel(id: string): Promise<ProviderModelData | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.providerModelById(id));
    if (!res.ok) return null;
    const body = await parseApiResponse<ProviderModelData>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('provider model edit page: fetch failed', { id, err });
    return null;
  }
}

export default async function EditProviderModelPage({ params }: Props) {
  const { id } = await params;
  const model = await getModel(id);

  if (!model) notFound();

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
          <span>{model.name}</span>
        </nav>
        <h1 className="text-2xl font-semibold">Edit: {model.name}</h1>
        <p className="text-muted-foreground text-sm">
          Update this model&apos;s characteristics.{' '}
          {model.isDefault && (
            <span className="text-amber-600 dark:text-amber-400">
              This is a seed-managed model — editing it will make it admin-managed.
            </span>
          )}
        </p>
      </header>

      <ProviderModelForm model={model} />
    </div>
  );
}
