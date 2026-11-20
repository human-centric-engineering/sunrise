import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

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

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.supportAccess');
  return { title: t('metaTitle'), description: t('metaDescription') };
}

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
  const t = await getTranslations('admin.supportAccess');

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
      ) : (
        <>
          {/* No form without the list: granting replaces the open grant, and
              the owner is told so only when the page knows there is one. */}
          {!isOwner ? (
            <Unavailable>{t('ownerOnly')}</Unavailable>
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
              {isOwner ? t('loadFailedOwner') : t('loadFailed')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
