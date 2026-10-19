import type { Metadata } from 'next';

import { OrgsTable, type OrgListItem } from '@/components/admin/orgs/orgs-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

export const metadata: Metadata = {
  title: 'Organisations',
  description: 'Every organisation on this install, and the providers each may use.',
};

/**
 * Admin — Organisations list (§120 t-745).
 *
 * Thin server shell over `GET /api/v1/admin/orgs`, the enriched list. The
 * admin tree is platform-admin only, and so is the route. A failed load
 * throws to the admin error boundary rather than rendering the table's empty
 * state (#518).
 */
async function getOrgs(): Promise<OrgListItem[]> {
  const { data } = await requireServerData<{ orgs: OrgListItem[] }>(API.ADMIN.ORGS);
  return Array.isArray(data?.orgs) ? data.orgs : [];
}

export default async function OrgsPage() {
  const orgs = await getOrgs();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">
          Organisations{' '}
          <FieldHelp title="What is an organisation?">
            <p>
              An organisation is a tenant: its agents, knowledge and conversations are kept apart
              from every other organisation&apos;s. The install organisation exists on every install
              and is the only one when multi-tenancy is off.
            </p>
            <p className="mt-2">
              Open an organisation to choose which AI providers it may use. Renaming, suspending and
              managing members are done through the API for now.
            </p>
          </FieldHelp>
        </h1>
        <p className="text-muted-foreground text-sm">
          Every organisation on this install. Open one to set the providers it may use.
        </p>
      </header>

      <OrgsTable orgs={orgs} installOrgId={INSTALL_ORG_ID} />
    </div>
  );
}
