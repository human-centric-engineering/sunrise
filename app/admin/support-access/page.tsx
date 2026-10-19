import type { Metadata } from 'next';

import { SupportActivityTable } from '@/components/admin/support-access/support-activity-table';
import { SupportGrantForm } from '@/components/admin/support-access/support-grant-form';
import {
  SupportGrantsTable,
  type SupportGrantRow,
} from '@/components/admin/support-access/support-grants-table';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg, requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant } from '@/lib/tenancy/context';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

export const metadata: Metadata = {
  title: 'Support access',
  description: 'Let the platform’s support staff into this organisation, for a limited time.',
};

/**
 * Admin — Support access for the org being administered (§121 t-823).
 *
 * Org-tier: the org's OWNER/ADMIN open it for the org they act in. A thin
 * shell over `GET /api/v1/orgs/[id]/support-grants`; the routes decide who may
 * do what. The grant form is shown to an owner of this org only, because the
 * API refuses anyone else, platform admins included — the vendor does not
 * grant itself access. Revoke is offered to everyone who can see the list.
 * Below the grants, what support did under them (t-825). Grants that cannot
 * be loaded say so in the list's place, never as "no grants";
 * `loadServerData` logs the failure (#518).
 */
async function getGrants(orgId: string): Promise<SupportGrantRow[] | null> {
  const result = await loadServerData<{ grants: SupportGrantRow[] }>(API.ORGS.supportGrants(orgId));
  return result.ok && Array.isArray(result.data?.grants) ? result.data.grants : null;
}

function Unavailable({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-sm">{children}</p>;
}

export default async function SupportAccessPage() {
  const [org, entry] = await Promise.all([requestActingOrg(), requestPrincipal()]);
  const grants = org && org.id !== INSTALL_ORG_ID ? await getGrants(org.id) : null;
  const isOwner = entry?.principal.orgId === org?.id && entry?.principal.orgRole === ORG_OWNER_ROLE;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Support access{org ? ` for ${org.name}` : ''}</h1>
        <p className="text-muted-foreground text-sm">
          Whether the platform&apos;s support staff may work inside this organisation, and for how
          long.
        </p>
      </header>

      {!isMultiTenant() ? (
        <Unavailable>
          Support access is for installs with more than one organisation. This install has one.
        </Unavailable>
      ) : !org ? (
        <Unavailable>
          You are not acting in an organisation, so there is nothing to grant.
        </Unavailable>
      ) : org.id === INSTALL_ORG_ID ? (
        <Unavailable>
          The install organisation belongs to the platform, so its staff need no grant to work in
          it. Switch to a customer organisation to see its grants.
        </Unavailable>
      ) : (
        <>
          {/* No form without the list: granting replaces the open grant, and
              the owner is told so only when the page knows there is one. */}
          {!isOwner ? (
            <Unavailable>Only an owner of this organisation can grant support access.</Unavailable>
          ) : grants ? (
            <SupportGrantForm
              orgId={org.id}
              replacesOpenGrant={grants.some((grant) => grant.open)}
            />
          ) : null}
          {grants ? (
            <>
              <SupportGrantsTable orgId={org.id} grants={grants} />
              {grants.length > 0 && <SupportActivityTable orgId={org.id} grants={grants} />}
            </>
          ) : (
            <p role="alert" className="text-destructive text-sm">
              The support grants for this organisation could not be loaded
              {isOwner ? ', so support access cannot be granted until they can.' : '.'}
            </p>
          )}
        </>
      )}
    </div>
  );
}
