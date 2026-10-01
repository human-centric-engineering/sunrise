import type { Metadata } from 'next';

import { OrgsTable, type OrgListItem } from '@/components/admin/orgs/orgs-table';
import { FieldHelp } from '@/components/ui/field-help';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

export const metadata: Metadata = {
  title: 'Organisations',
  description: 'Every organisation on this install, and the providers each may use.',
};

/**
 * Admin — Organisations list (§120 t-745).
 *
 * Thin server shell over `GET /api/v1/admin/orgs`, the enriched list. The
 * admin tree is platform-admin only, and so is the route. A fetch failure
 * renders the table's empty state rather than throwing.
 */
async function getOrgs(): Promise<OrgListItem[]> {
  try {
    const res = await serverFetch(API.ADMIN.ORGS);
    if (!res.ok) return [];
    const body = await parseApiResponse<{ orgs: OrgListItem[] }>(res);
    return body.success && Array.isArray(body.data?.orgs) ? body.data.orgs : [];
  } catch (err) {
    logger.error('orgs list page: fetch failed', err);
    return [];
  }
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
