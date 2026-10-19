import type { Metadata } from 'next';
import Link from 'next/link';

import { MemberInviteForm } from '@/components/admin/members/member-invite-form';
import { MembersTable, type OrgMember } from '@/components/admin/members/members-table';
import { API } from '@/lib/api/endpoints';
import { loadServerData } from '@/lib/api/server-load';
import { requestActingOrg, requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

export const metadata: Metadata = {
  title: 'Members',
  description: 'The people in this organisation, and their roles.',
};

/**
 * Admin — Members of the org being administered (§111 t-813).
 *
 * Org-tier: an org OWNER/ADMIN opens it for the org they act in, and a
 * platform admin sees it for whichever org they are in. Users (install-wide)
 * and Organisations stay the platform's. A thin shell over
 * `GET /api/v1/orgs/[id]/members`. The members routes and the invitations
 * route decide who may do what, and this page adds no rule of its own.
 * A roster that cannot be loaded says so in the table's place, never as an
 * empty roster; `loadServerData` logs the failure (#518).
 */
async function getMembers(orgId: string): Promise<OrgMember[] | null> {
  const result = await loadServerData<{ members: OrgMember[] }>(API.ORGS.members(orgId));
  return result.ok && Array.isArray(result.data?.members) ? result.data.members : null;
}

export default async function MembersPage() {
  const [org, entry] = await Promise.all([requestActingOrg(), requestPrincipal()]);
  const members = org ? await getMembers(org.id) : null;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Members{org ? ` of ${org.name}` : ''}</h1>
        <p className="text-muted-foreground text-sm">
          Who is in this organisation, and what each person may do in it.
        </p>
      </header>

      {!org ? (
        <p className="text-muted-foreground text-sm">
          You are not acting in an organisation, so there are no members to show.
        </p>
      ) : (
        <>
          {org.id === INSTALL_ORG_ID && (
            <p className="text-muted-foreground text-sm">
              Roles in the install organisation follow each person&apos;s platform role. Invite
              people and change their roles from{' '}
              <Link href="/admin/users" className="underline">
                Users
              </Link>
              .
            </p>
          )}
          <MemberInviteForm orgId={org.id} />
          {members ? (
            <MembersTable
              orgId={org.id}
              members={members}
              currentUserId={entry?.principal.userId ?? null}
            />
          ) : (
            <p role="alert" className="text-destructive text-sm">
              The members of this organisation could not be loaded.
            </p>
          )}
        </>
      )}
    </div>
  );
}
