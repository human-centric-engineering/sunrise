/**
 * Entering an org for a request — the read rule the guards apply (§106).
 *
 * One function per credential class the guards admit, both answering the
 * same question: **which org is this request acting for, as what, and may
 * it?** The answer is either an entry (org, role, how it was decided) or a
 * refusal the guard turns into a 403 that names nothing.
 *
 * **The install org needs no membership read at `single`.** On a
 * single-tenant install every user is a member of the install org (the
 * identity invariant, `.context/tenancy/identity.md`) and their role in it is
 * the platform role's projection — `initialMembershipFor`'s rule, the ONE
 * statement the migration's backfill and the signup hook also apply. So when
 * a session's `activeOrgId` is null or the install org, the entry is derived
 * from the session with no query. That is not a shortcut around the model; it
 * is the model: at `single` the install org is the only answer. It is also
 * what keeps the guards' hot path free of a per-request read on every
 * single-tenant install, and every route test that runs the real guard free
 * of a Prisma mock it never needed. The membership row IS read — and
 * verified: present, org `ACTIVE` — whenever the request names any other org,
 * a resolver header is present, or the install runs `multi`.
 *
 * **Refusals do not enumerate.** "Not a member" and "no such org" are one
 * answer; a suspended org is refused with the same shape. The guard's own
 * log line carries the detail.
 *
 * **API keys.** Feature finding 13: an `admin`-scoped key is a platform
 * credential and enters no org; any other key enters the org it was minted
 * in, or — while that column is still `NULL` (t-673 binds it) — the install
 * org at `single` and nothing at `multi`.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { hasScope } from '@/lib/auth/api-key-scopes';
import { initialMembershipFor, type NewUserShape } from '@/lib/tenancy/membership';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { isMultiTenant, type TenantContextSource } from '@/lib/tenancy/context';
import type { OrgRole } from '@/lib/tenancy/roles';

/** A request may act for this org, as this role. */
export interface OrgEntry {
  orgId: string;
  role: OrgRole | null;
  source: Extract<TenantContextSource, 'session' | 'api-key' | 'resolver'>;
}

/** Why a request may not act for the org it named. */
export type OrgRefusal =
  { refused: 'not-a-member' } | { refused: 'org-suspended' } | { refused: 'no-org' };

export type OrgEntryResult = OrgEntry | OrgRefusal;

export function isOrgRefusal(result: OrgEntryResult): result is OrgRefusal {
  return 'refused' in result;
}

type MembershipReader = Pick<PrismaClient, 'orgMembership'>;

/** Read and verify one membership: present, and its org active. */
async function verifiedMembership(
  userId: string,
  orgId: string,
  db: MembershipReader
): Promise<{ role: OrgRole } | OrgRefusal> {
  const membership = await db.orgMembership.findUnique({
    where: { orgId_userId: { orgId, userId } },
    select: { role: true, org: { select: { status: true } } },
  });
  if (!membership) return { refused: 'not-a-member' };
  if (membership.org.status !== 'ACTIVE') return { refused: 'org-suspended' };
  return { role: membership.role };
}

/**
 * The org a cookie session acts for.
 *
 * `headerOrgId` is the proxy-written resolver header, verified here exactly
 * like a session's own choice — it decides WHICH org for this request, never
 * whether the caller may enter it. It wins over `activeOrgId` because a fork
 * that resolves tenants by hostname means "this request is for the org at
 * this hostname", whatever the cookie last recorded.
 */
export async function enterSessionOrg(
  user: NewUserShape & { id: string },
  activeOrgId: string | null | undefined,
  headerOrgId: string | null,
  db: MembershipReader = prisma
): Promise<OrgEntryResult> {
  if (headerOrgId) {
    const membership = await verifiedMembership(user.id, headerOrgId, db);
    return 'refused' in membership
      ? membership
      : { orgId: headerOrgId, role: membership.role, source: 'resolver' };
  }

  const multi = isMultiTenant();

  if (!activeOrgId) {
    if (multi) return { refused: 'no-org' };
    return { orgId: INSTALL_ORG_ID, role: initialMembershipFor(user).role, source: 'session' };
  }

  if (activeOrgId === INSTALL_ORG_ID && !multi) {
    return { orgId: INSTALL_ORG_ID, role: initialMembershipFor(user).role, source: 'session' };
  }

  const membership = await verifiedMembership(user.id, activeOrgId, db);
  return 'refused' in membership
    ? membership
    : { orgId: activeOrgId, role: membership.role, source: 'session' };
}

/**
 * The org an API key acts for — or, for an `admin`-scoped key, none.
 *
 * `null` (rather than a refusal) is the platform-credential answer: the
 * guard runs the handler outside any org scope, which at `single` still
 * resolves to the install org for anything that asks and at `multi` is the
 * audited "sees everything" a platform key has always been (design decision
 * Q6). The owner's membership is read only when the key's org is one whose
 * membership must be verified; for the install org at `single` the role is
 * the owner's platform role projected, as for a session.
 */
export async function enterApiKeyOrg(
  key: { userId: string; scopes: readonly string[]; orgId: string | null; owner: NewUserShape },
  db: MembershipReader = prisma
): Promise<OrgEntryResult | null> {
  if (hasScope([...key.scopes], 'admin')) return null;

  const multi = isMultiTenant();

  if (!key.orgId) {
    if (multi) return { refused: 'no-org' };
    return { orgId: INSTALL_ORG_ID, role: initialMembershipFor(key.owner).role, source: 'api-key' };
  }

  if (key.orgId === INSTALL_ORG_ID && !multi) {
    return { orgId: INSTALL_ORG_ID, role: initialMembershipFor(key.owner).role, source: 'api-key' };
  }

  const membership = await verifiedMembership(key.userId, key.orgId, db);
  return 'refused' in membership
    ? membership
    : { orgId: key.orgId, role: membership.role, source: 'api-key' };
}
