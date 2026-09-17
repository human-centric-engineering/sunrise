/**
 * Org membership — the write path for "every user belongs to an org".
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
 *
 * Server-side: reaches Prisma. The vocabulary it writes is
 * `lib/tenancy/roles.ts`, which is what a client component imports instead.
 */
import type { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { isPlatformAdmin } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { DEFAULT_ORG_ROLE, ORG_OWNER_ROLE, type OrgRole } from '@/lib/tenancy/roles';

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
 * §106 t-670 adds the invitation-derived alternative (an invited user lands in
 * the invitation's org with its role); this stays the default arm.
 */
export function initialMembershipFor(user: {
  role?: string | null;
  accountType?: string | null;
}): InitialMembership {
  const ownsInstall = isPlatformAdmin(user) && user.accountType !== 'SERVICE';
  return { orgId: INSTALL_ORG_ID, role: ownsInstall ? ORG_OWNER_ROLE : DEFAULT_ORG_ROLE };
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
 * write lands on the same connection as the user it just upserted.
 *
 * **Fork note — better-auth's `transaction` option.** Sunrise passes no
 * `transaction` to `prismaAdapter`, so its hooks run "as-is" and the user row
 * this writes against is visible on the shared client. A fork that enables
 * `prismaAdapter(prisma, { transaction: true })` gets a real interactive
 * transaction: the user row is not yet visible on the singleton's connection,
 * this upsert fails `org_membership_userId_fkey` on every signup, and every
 * signup logs the error above. Such a fork should pass the transaction's
 * client through the hook (better-auth's `getCurrentAdapter()`) as `db`.
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
