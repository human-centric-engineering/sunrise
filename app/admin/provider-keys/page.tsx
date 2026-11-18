import type { Metadata } from 'next';

import { ProviderKeysList } from '@/components/admin/provider-keys/provider-keys-list';
import {
  SAVE_BLOCKED_SENTENCE,
  type ProviderKeyRow,
  type ProviderKeySaveBlocked,
} from '@/components/admin/provider-keys/provider-key-states';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant } from '@/lib/tenancy/context';

export const metadata: Metadata = {
  title: 'AI keys',
  description: 'Run this organisation’s AI calls on its own provider accounts.',
};

interface ProviderKeysData {
  switchedOn: boolean;
  saveBlocked: ProviderKeySaveBlocked | null;
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

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">AI keys{org ? ` for ${org.name}` : ''}</h1>
        <p className="text-muted-foreground text-sm">
          Run this organisation&apos;s AI calls on its own account with a provider, so the provider
          bills you directly and works under your agreement with them.
        </p>
      </header>

      {!isMultiTenant() ? (
        <Unavailable>
          Organisations&apos; own AI keys are for installs with more than one organisation. This
          install has one, and its keys are set where providers are configured.
        </Unavailable>
      ) : !org ? (
        <Unavailable>
          You are not acting in an organisation, so there are no keys to show.
        </Unavailable>
      ) : org.id === INSTALL_ORG_ID ? (
        <Unavailable>
          The install organisation runs on the platform&apos;s own keys, which are set where
          providers are configured. Switch to a customer organisation to see its keys.
        </Unavailable>
      ) : !data ? (
        <p role="alert" className="text-destructive text-sm">
          This organisation&apos;s AI keys could not be loaded.
        </p>
      ) : (
        <>
          {data.saveBlocked && (
            <p role="note" className="rounded-md border p-3 text-sm">
              {SAVE_BLOCKED_SENTENCE[data.saveBlocked]}
            </p>
          )}
          <ProviderKeysList
            orgId={org.id}
            providers={data.providers}
            canSave={data.saveBlocked === null}
          />
        </>
      )}
    </div>
  );
}
