import type { Metadata } from 'next';

import {
  OrgOptionsForm,
  type OrgOptionsView,
} from '@/components/admin/org-options/org-options-form';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg } from '@/lib/auth/admin-page-viewer';

export const metadata: Metadata = {
  title: 'Options',
  description: 'Turn parts of the app on or off for this organisation.',
};

/**
 * Admin — the options this organisation's own admins may set (§135 t-1054).
 *
 * Org-tier: the org's OWNER/ADMIN open it for the org they act in. A thin
 * shell over `GET /api/v1/orgs/[id]/entitlements`, which lists the switches
 * the app registers `setBy: 'org'`; the route decides who may change them.
 * Options that cannot be loaded say so in the form's place, never as "no
 * options"; `loadServerData` logs the failure (#518).
 */
async function getOptions(orgId: string): Promise<OrgOptionsView | null> {
  const result = await loadServerData<OrgOptionsView>(API.ORGS.entitlements(orgId));
  return result.ok && Array.isArray(result.data?.switches) ? result.data : null;
}

export default async function OrgOptionsPage() {
  const org = await requestActingOrg();
  const options = org ? await getOptions(org.id) : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Options{org ? ` for ${org.name}` : ''}</h1>
        <p className="text-muted-foreground text-sm">
          Turn parts of the app on or off for everyone in this organisation.
        </p>
      </header>

      {!org ? (
        <p className="text-muted-foreground text-sm">
          You are not acting in an organisation, so there are no options to show.
        </p>
      ) : !options ? (
        <p role="alert" className="text-destructive text-sm">
          This organisation&apos;s options could not be loaded.
        </p>
      ) : (
        <OrgOptionsForm orgId={org.id} options={options} />
      )}
    </div>
  );
}
