/**
 * The orgs the caller belongs to (§106 t-672)
 *
 * GET /api/v1/orgs — every membership of the signed-in user, with the org's
 * id / slug / name / status and the caller's role in it, and which one the
 * session is acting in. The member view's entry point: what `POST
 * /api/v1/orgs/switch` switches between.
 *
 * Deliberately does NOT enter the session's current org
 * (`tenancy: { entersOrg: false }`, the switch's own reason): a member whose
 * active org was suspended, or who was removed from it, is refused by the
 * guard everywhere else — and this list is how they find the org to leave
 * to. Suspended orgs are listed with their status rather than hidden, so the
 * caller can see why a switch to one would be refused.
 */

import { headers } from 'next/headers';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

export const GET = withAuth(
  async (_request, session) => {
    const memberships = await prisma.orgMembership.findMany({
      where: { userId: session.user.id },
      select: {
        role: true,
        createdAt: true,
        org: { select: { id: true, slug: true, name: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    // The org this request acts for. An API-key caller was entered by the
    // guard (`entersOrg: false` only skips the cookie-session entry), so the
    // principal already says which org — the key's own. A cookie session was
    // not entered here, so the answer is derived in the entry rule's own
    // precedence: the proxy's resolver header (the proxy is its sole writer —
    // a fork resolving by hostname means "this host IS this org", whatever
    // the cookie last recorded), else the session's pointer, else the install
    // org at `single` and no org at `multi`. Read from `headers()` as the
    // guard does, so the two never disagree; read, not entered — this route
    // stays outside any scope so a refused org still gets its list.
    const activeOrgId =
      session.principal.orgId ??
      ((await headers()).get(TENANT_HEADER_NAME) ||
        session.session.activeOrgId ||
        (isMultiTenant() ? null : INSTALL_ORG_ID));

    return successResponse({
      activeOrgId,
      orgs: memberships.map((membership) => ({
        ...membership.org,
        role: membership.role,
        joinedAt: membership.createdAt,
        active: membership.org.id === activeOrgId,
      })),
    });
  },
  {
    // Ownership: this route is self-scoped by construction — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'self',
      because:
        'Reads the membership rows keyed on `session.user.id`; no other subject can be named.',
    },
    tenancy: {
      entersOrg: false,
      because:
        'The list a member of a refused org needs in order to switch out of it; entering first would hide it from exactly that member.',
    },
  }
);
