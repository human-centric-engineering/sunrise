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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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

export default async function EditProviderModelPage({ params, searchParams }: Props) {
  const { id } = await params;
  const query = await searchParams;
  const justCreated = query.created === '1';
  const model = await getModel(id);

  if (!model) notFound();

  return (
    <div className="space-y-6">
      {justCreated && (
        <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
          Model created successfully. You can now edit its details below.
        </div>
      )}
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
              This is a seed-managed model — editing it will make it admin-managed and future
              re-seeds will skip this row.
            </span>
          )}
        </p>
      </header>

      <ProviderModelForm model={model} />
    </div>
  );
}
