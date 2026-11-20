import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import { ProviderKeysList } from '@/components/admin/provider-keys/provider-keys-list';
import {
  type ProviderKeyRow,
  type ProviderKeySaveBlocked,
} from '@/components/admin/provider-keys/provider-key-states';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant } from '@/lib/tenancy/context';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.providerKeys');
  return { title: t('metaTitle'), description: t('metaDescription') };
}

interface ProviderKeysData {
  saveBlocked: ProviderKeySaveBlocked | null;
  readOnly: boolean;
  providers: ProviderKeyRow[];
}

/**
 * Admin — this organisation's own AI keys (§137 t-1045).
 *
 * Org-tier: the org's OWNER/ADMIN open it for the org they act in. A thin
 * shell over `GET /api/v1/orgs/[id]/provider-keys`; the routes decide who may
 * do what, and the page offers saving only where that route says it is not
 * blocked (switched off, no master key, or a support session). Keys that
 * cannot be loaded say so in the list's place, never as "no keys";
 * `loadServerData` logs the failure (#518).
 */
async function getKeys(orgId: string): Promise<ProviderKeysData | null> {
  const result = await loadServerData<ProviderKeysData>(API.ORGS.providerKeys(orgId));
  return result.ok && Array.isArray(result.data?.providers) ? result.data : null;
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

export default async function ProviderKeysPage() {
  const org = await requestActingOrg();
  const data = isMultiTenant() && org && org.id !== INSTALL_ORG_ID ? await getKeys(org.id) : null;
  const t = await getTranslations('admin.providerKeys');

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">
          {org ? t('titleFor', { org: org.name }) : t('title')}
        </h1>
        <p className="text-muted-foreground text-sm">{t('intro')}</p>
      </header>

      {!isMultiTenant() ? (
        <Unavailable>{t('singleTenant')}</Unavailable>
      ) : !org ? (
        <Unavailable>{t('noOrg')}</Unavailable>
      ) : org.id === INSTALL_ORG_ID ? (
        <Unavailable>{t('installOrg')}</Unavailable>
      ) : !data ? (
        <p role="alert" className="text-destructive text-sm">
          {t('loadFailed')}
        </p>
      ) : (
        <>
          {data.readOnly ? (
            <p role="note" className="rounded-md border p-3 text-sm">
              {t('readOnly')}
            </p>
          ) : (
            data.saveBlocked && (
              <p role="note" className="rounded-md border p-3 text-sm">
                {t(`saveBlocked.${data.saveBlocked}`)}
              </p>
            )
          )}
          <ProviderKeysList
            orgId={org.id}
            providers={data.providers}
            canSave={data.saveBlocked === null && !data.readOnly}
            canChange={!data.readOnly}
            masterKeyMissing={data.saveBlocked === 'master_key_missing'}
          />
        </>
      )}
    </div>
  );
}
