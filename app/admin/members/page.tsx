import type { Metadata } from 'next';

import { MemberInviteForm } from '@/components/admin/members/member-invite-form';
import { MembersTable, type OrgMember } from '@/components/admin/members/members-table';
import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { requestActingOrg, requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { logger } from '@/lib/logging';

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
 */
async function getMembers(orgId: string): Promise<OrgMember[] | null> {
  try {
    const res = await serverFetch(API.ORGS.members(orgId));
    if (!res.ok) return null;
    const body = await parseApiResponse<{ members: OrgMember[] }>(res);
    return body.success && Array.isArray(body.data?.members) ? body.data.members : null;
  } catch (err) {
    logger.error('members page: fetch failed', err);
    return null;
  }
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
