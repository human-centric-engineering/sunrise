/**
 * Org membership — the write path for "every user belongs to an org", and
 * the read that tells a new session which org it acts in.
 *
 * Two halves make principle 1 of the tenancy design
 * (`.context/architecture/multi-tenancy-design.md`) hold: the identity
 * migration backfills a membership for every user that already existed, and
 * `userCreateAfterHook` (`lib/auth/config.ts`) calls {@link ensureMembership}
 * for every user created afterwards. One writer bypasses both: the seeded
 * SERVICE config-owner (`prisma/seeds/001-system-owner.ts`) is upserted with
 * Prisma directly, and on a FRESH database it is created after the migration
 * ran — so that seed calls {@link ensureMembership} itself. This module is
 * the shared half, and
 * {@link initialMembershipFor} is the ONE statement of the role rule both
 * halves apply — the migration's SQL `CASE` and this function are asserted to
 * agree by `tests/unit/lib/tenancy/migration.test.ts`.
 * {@link membershipForNewUser} layers the invitation on top of it, and
 * {@link activeOrgForSession} is the read side: which of a user's orgs a new
 * session starts in, and the self-heal for a user who has none.
 *
 * Server-side: reaches Prisma. The vocabulary it writes is
 * `lib/tenancy/roles.ts`, which is what a client component imports instead.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_OWNER_ROLE, type OrgRole } from '@/lib/tenancy/roles';

/** The shape better-auth hands the user hooks, as far as the role rule reads it. */
export interface NewUserShape {
  role?: string | null;
  accountType?: string | null;
}

/**
 * What an accepted invitation says about where its user lands — the org keys
 * of `InvitationMetadata` plus the platform role it grants. Structural rather
 * than the metadata type itself so the OAuth path, which reads its invitation
 * before the row is consumed, and the password path, which carries it through
 * `runInvitedSignup`, hand over the same thing.
 */
export interface AcceptedInvitation {
  /** The platform role the invitation grants. */
  role?: string | null;
  /** The org it names; absent ⇒ the install org. */
  orgId?: string | null;
  /** The org role it names; absent ⇒ the rule's default. */
  orgRole?: OrgRole | null;
}

/** Where a new user lands, and as what. */
export interface InitialMembership {
  orgId: string;
  role: OrgRole;
}

/**
 * The membership a newly created user gets when nothing else chooses one.
 *
 * Install org, and the role rule the byte-identical argument needs: a real
 * (HUMAN) platform admin becomes OWNER of the install org; everyone else —
 * including the seeded SERVICE config-owner, which holds platform `ADMIN` but
 * never logs in — becomes MEMBER. So nobody gains an org-level grant they did
 * not already hold as platform admin, and at `single` the org layer changes
 * nothing about who may do what.
 *
 * Takes the structural shape better-auth hands the database hooks rather than
 * a Prisma `User`, so the hook can call it before anything re-reads the row.
 * {@link membershipForNewUser} layers an accepted invitation on top (an invited
 * user lands in the invitation's org with its role); this stays the default arm.
 */
export function initialMembershipFor(user: NewUserShape): InitialMembership {
  const ownsInstall = isPlatformAdmin(user) && user.accountType !== 'SERVICE';
  return { orgId: INSTALL_ORG_ID, role: ownsInstall ? ORG_OWNER_ROLE : DEFAULT_ORG_ROLE };
}

/**
 * The membership a new user gets, given the invitation (if any) that admitted
 * them — one function of `(user, invitation)`, so the three creation paths
 * (public signup, password accept-invite, OAuth accept-invite) cannot answer
 * it differently.
 *
 * - No invitation, or one naming no org: {@link initialMembershipFor}, judged
 *   on the platform role the invitation **grants** rather than the role the
 *   row happened to carry at creation — the password accept-invite route
 *   applies `metadata.role` only after `signUpEmail` returns, so an invited
 *   platform ADMIN judged on the row would land as `MEMBER` (t-669's finding).
 *   An explicit `orgRole` on the install org is honoured as written.
 * - An invitation naming another org: that org. Its role is the invitation's
 *   `orgRole`, default `MEMBER` — except that **the first member of an org
 *   becomes its `OWNER`**, whatever the invitation said. That is the per-org
 *   bootstrap (an org with no owner is one nobody can administer), and it is
 *   scoped to non-install orgs on purpose: the install org's owner is decided
 *   by the platform role, and on a fresh database its first member is the
 *   seeded SERVICE account, which must stay `MEMBER`.
 *
 * Reads the org's membership count for the bootstrap arm; a null `db` is not
 * accepted so a caller cannot skip that read by accident.
 */
export async function membershipForNewUser(
  user: NewUserShape,
  invitation: AcceptedInvitation | null,
  db: Pick<PrismaClient, 'orgMembership'> = prisma
): Promise<InitialMembership> {
  const orgId = invitation?.orgId ?? INSTALL_ORG_ID;

  if (orgId === INSTALL_ORG_ID) {
    const byRule = initialMembershipFor({ ...user, role: invitation?.role ?? user.role });
    return invitation?.orgRole ? { orgId, role: invitation.orgRole } : byRule;
  }

  const existingMembers = await db.orgMembership.count({ where: { orgId } });
  const role = existingMembers === 0 ? ORG_OWNER_ROLE : (invitation?.orgRole ?? DEFAULT_ORG_ROLE);
  return { orgId, role };
}

/**
 * Which org a new session for `userId` starts in — and the self-heal for a
 * user who belongs to none.
 *
 * The choice, in order, over the user's memberships in ACTIVE orgs: their
 * only one; else the install org if they are a member of it (the org every
 * single-tenant user is in, and the one a multi-membership user least often
 * means to leave); else the org they joined most recently. A user whose
 * every org is suspended starts in the most recent of those and is refused
 * at entry — suspension means they cannot act there, and starting them
 * nowhere would be the same refusal with a worse cookie. A user with **no
 * membership at all** — the signup
 * hook's write failed, or a fork created the row some other way — is given
 * the install-org default by {@link initialMembershipFor} right here, because
 * a session is the one thing every sign-in mints, so this is where a missing
 * membership is guaranteed to be noticed. That write is what makes t-671's
 * refusal of a memberless user at `multi` rare rather than permanent.
 *
 * Returns the org id and whether it wrote a membership, so the hook can log
 * the self-heal — it is an `error`-level event upstream, and silence here
 * would hide that the signup path is failing.
 *
 * `Org.status` is read only to choose AMONG several memberships: a member of
 * one suspended and one active org starts in the active one, because the
 * alternative — starting them in the suspended one and refusing every request
 * — is a lockout, not a suspension. It is never used to invent a membership:
 * a user whose only org is suspended starts there and is refused at entry
 * (the guard, and the switch as an explicit action), and the self-heal below
 * runs only for a user with no membership at all. Suspension is enforced
 * where a request enters an org, not by hiding the org from the session.
 */
export async function activeOrgForSession(
  userId: string,
  db: Pick<PrismaClient, 'orgMembership' | 'user'> = prisma
): Promise<{ orgId: string; healed: boolean }> {
  const all = await db.orgMembership.findMany({
    where: { userId },
    select: { orgId: true, createdAt: true, org: { select: { status: true } } },
    orderBy: { createdAt: 'desc' },
  });
  // Choose among active orgs; fall back to the suspended ones only when
  // there is nothing else — never to no membership at all.
  const active = all.filter((m) => m.org.status === 'ACTIVE');
  const memberships = active.length > 0 ? active : all;

  if (memberships.length === 1) return { orgId: memberships[0].orgId, healed: false };
  if (memberships.some((m) => m.orgId === INSTALL_ORG_ID)) {
    return { orgId: INSTALL_ORG_ID, healed: false };
  }
  if (memberships.length > 0) return { orgId: memberships[0].orgId, healed: false };

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true, accountType: true },
  });
  // No user row means no session can be minted for it either; the FK on the
  // membership would refuse the write, so answer the default and let the
  // guard's own null handling take it from here.
  if (!user) return { orgId: INSTALL_ORG_ID, healed: false };

  const membership = initialMembershipFor(user);
  await ensureMembership(userId, membership, db);
  return { orgId: membership.orgId, healed: true };
}

/**
 * Make `userId` a member of `membership.orgId`, idempotently.
 *
 * An upsert on the `(orgId, userId)` unique with an empty update: a second
 * call is a no-op rather than a P2002, and — unlike a bare `create` — a
 * membership the migration or an operator already wrote is left as it is,
 * role included. Throws on any database failure; each caller decides what to
 * do with that — the signup hook logs and continues (see the comment there
 * for why a throw would be worse), the seed lets it fail the seed.
 *
 * `db` defaults to the shared client; a seed passes the runner's own so the
 * write lands on the same connection as the user it just upserted. The signup
 * hook needs no such care: better-auth runs `create.after` hooks after its
 * transaction has committed, in both its default "as-is" mode and with
 * `prismaAdapter(prisma, { transaction: true })`, so the user row is visible
 * on the shared client either way.
 */
export async function ensureMembership(
  userId: string,
  membership: InitialMembership,
  db: Pick<PrismaClient, 'orgMembership'> = prisma
): Promise<void> {
  await db.orgMembership.upsert({
    where: { orgId_userId: { orgId: membership.orgId, userId } },
    update: {},
    create: { orgId: membership.orgId, userId, role: membership.role },
  });
}
