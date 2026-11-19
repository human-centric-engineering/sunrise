import type { Metadata } from 'next';
import Link from 'next/link';

import {
  ProviderModelForm,
  type ProviderModelData,
  type ReplacementOption,
} from '@/components/admin/orchestration/provider-model-form';
import { API } from '@/lib/api/endpoints';
import { requireAllServerData, requireServerData } from '@/lib/api/server-load';
import { SharedSettingsReadOnlyNotice } from '@/components/admin/shared-settings-access';
import {
  ProviderModelUses,
  type ProviderModelLifecycleData,
  type ProviderModelUsesData,
} from '@/components/admin/orchestration/provider-model-uses';

/** The model route's answer: the row, plus its lifecycle and uses (§136 t-1065). */
type EditModelData = ProviderModelData & {
  lifecycle: ProviderModelLifecycleData;
  uses: ProviderModelUsesData;
};

export const metadata: Metadata = {
  title: 'Edit Provider Model · AI Orchestration',
  description: 'Update provider model characteristics and tier classification.',
};

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function EditProviderModelPage({ params, searchParams }: Props) {
  const { id } = await params;
  const query = await searchParams;
  const justCreated = query.created === '1';
  // A 404 is a missing model; any other failure reaches the error boundary.
  const { data: model } = await requireServerData<EditModelData>(
    API.ADMIN.ORCHESTRATION.providerModelById(id),
    { notFound: true }
  );
  const replacementOptions = await loadReplacementOptions(model);

  return (
    <div className="space-y-6">
      {justCreated && (
        <div className="rounded-md border border-emerald-500/50 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
          Model created successfully. You can now edit its details below.
        </div>
      )}
      <nav className="text-muted-foreground -mb-5 text-xs">
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

      <header className="bg-background sticky top-0 z-30 -mx-6 border-b px-6 pt-3 pb-3">
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

      <SharedSettingsReadOnlyNotice />

      <ProviderModelUses
        retiresAt={model.retiresAt ?? null}
        lifecycle={model.lifecycle}
        uses={model.uses}
      />

      <ProviderModelForm model={model} replacementOptions={replacementOptions} />
    </div>
  );
}

interface CatalogueRow extends ReplacementOption {
  isActive: boolean;
  retiresAt: string | null;
}

/**
 * The models on this one's provider it may name as its replacement (§136
 * t-1064): active, not themselves retiring, not itself. Capabilities are left
 * to the server's check, which says which one is missing. The stored
 * replacement stays listed even if it has stopped qualifying, so the form
 * shows what is saved rather than silently showing "none".
 */
async function loadReplacementOptions(model: ProviderModelData): Promise<ReplacementOption[]> {
  const rows = await requireAllServerData<CatalogueRow>(
    `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?providerSlug=${encodeURIComponent(model.providerSlug)}`
  );
  return rows
    .filter(
      (row) =>
        row.id === model.replacementId ||
        (row.id !== model.id && row.isActive && row.retiresAt === null)
    )
    .map(({ id, name, modelId }) => ({ id, name, modelId }));
}
