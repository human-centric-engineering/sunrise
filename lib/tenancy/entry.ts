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
 * in. A key whose column is still `NULL` — one minted between 0.12.0 and the
 * backfill that t-673 re-ran — is the install org at `single` and nothing
 * at `multi`.
 *
 * **Credentials with no user behind them** — an embed token, an MCP key
 * whose creator may be gone — enter through {@link resolveCredentialOrg}:
 * the same null rule, and the org's own status in place of a membership
 * (there is no member to verify). An agent invite token is not a credential
 * class here at all: it is a gate the SESSION passes through, so it never
 * enters a context of its own — `lib/orchestration/invite-tokens.ts`
 * compares its org with the one the guard already entered.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { hasScope } from '@/lib/auth/api-key-scopes';
import { initialMembershipFor, type NewUserShape } from '@/lib/tenancy/membership';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { getTenantContext, isMultiTenant, type TenantContextSource } from '@/lib/tenancy/context';
import { ForbiddenError } from '@/lib/api/errors';
import type { OrgRole } from '@/lib/tenancy/roles';

/** A request may act for this org, as this role. */
export interface OrgEntry {
  orgId: string;
  role: OrgRole | null;
  source: Extract<
    TenantContextSource,
    'session' | 'api-key' | 'resolver' | 'embed-token' | 'mcp-key'
  >;
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

/**
 * The org a user-less credential acts for, from the columns its resolver
 * already read — no query of its own.
 *
 * `orgId` is the row's column; `orgStatus` is the joined org's status (or
 * `null` when the column is null, so there was nothing to join). A null
 * column is the interim-key case the docblock above describes: the install
 * org at `single`, refused at `multi`. A suspended org refuses its tokens
 * exactly as it refuses its members' sessions — the widget on a suspended
 * customer's site stops answering. The install org cannot be suspended
 * (`INSTALL_ORG_IMMUTABLE`), so at `single` the status is not consulted.
 */
export function resolveCredentialOrg(
  credential: { orgId: string | null; orgStatus: string | null },
  source: Extract<TenantContextSource, 'embed-token' | 'mcp-key'>
): OrgEntryResult {
  const orgId = orgOfColumn(credential.orgId);
  if (!orgId) return { refused: 'no-org' };
  if (orgId === INSTALL_ORG_ID && !isMultiTenant()) return { orgId, role: null, source };
  if (credential.orgStatus !== 'ACTIVE') return { refused: 'org-suspended' };
  return { orgId, role: null, source };
}

/**
 * What a credential's nullable `orgId` column means, in one place: the org
 * it names, else the install org at `single` and no org at `multi`. The
 * null arm exists for rows minted before the column was written (0.12.0 to
 * the t-673 backfill); nothing mints a null org any more.
 */
export function orgOfColumn(orgId: string | null | undefined): string | null {
  if (orgId) return orgId;
  return isMultiTenant() ? null : INSTALL_ORG_ID;
}

/**
 * The org a credential minted on this call stack is bound to (t-673).
 *
 * The guard entered it for the request, so this is one read of the tenant
 * context — never a body field: a caller cannot mint into an org they are
 * not acting in. When nothing was entered — an `admin`-scoped API key
 * calling an admin mint route — the answer is the install org at `single`
 * (the implicit context, which is what those callers have always minted
 * into) and a refusal at `multi`, where there is no org to bind and a
 * browser session acting in one is the way to mint. `requireTenantContext`
 * would throw a plain `Error` there; this is a 403 that names nothing.
 */
export function orgForMint(): string {
  const current = getTenantContext();
  if (current?.orgId) return current.orgId;
  if (!isMultiTenant()) return INSTALL_ORG_ID;
  throw new ForbiddenError('Minting a credential requires an org context');
}
