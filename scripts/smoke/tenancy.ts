/**
 * Tenancy identity smoke (§106 t-669).
 *
 * Proves, against a real Postgres, the invariant the identity migration and
 * `userCreateAfterHook` establish between them and that no mocked test can
 * reach: the install org exists with the fixed id, EVERY user is a member of
 * it (the backfill), the backfill's role rule held (a real platform admin is
 * OWNER, everyone else MEMBER), a credential row is bound to the install org,
 * a user created now gets a membership too, and deleting a user takes their
 * membership with them (Cascade) while the org stands.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-test-tenancy-*` rows and removes them on every path. Never uses
 * unscoped deletes or touches seed data.
 *
 * Run with:
 *   npm run smoke:tenancy
 *   npx tsx --env-file=.env.local scripts/smoke/tenancy.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db/client';
import { humanAdminWhere, serviceAccountWhere } from '@/lib/auth/account';
import { INSTALL_ORG_ID, INSTALL_ORG_SLUG } from '@/lib/tenancy/constants';
import { ensureMembership, initialMembershipFor } from '@/lib/tenancy/membership';
import { DEFAULT_ORG_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const PREFIX = 'smoke-test-tenancy';
const stamp = Date.now();

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:tenancy skipped — no database reachable (DATABASE_URL unset or DB down).');
    return;
  }

  let memberUserId: string | null = null;
  let apiKeyId: string | null = null;
  let chatKeyId: string | null = null;
  let adminKeyId: string | null = null;

  try {
    // ── The install org ────────────────────────────────────────────────────
    const install = await prisma.org.findUnique({ where: { id: INSTALL_ORG_ID } });
    check(install !== null, `install org exists with id "${INSTALL_ORG_ID}"`);
    check(install?.slug === INSTALL_ORG_SLUG, `install org slug is "${INSTALL_ORG_SLUG}"`);
    check(install?.status === 'ACTIVE', 'install org is ACTIVE');
    check((await prisma.org.count()) >= 1, 'at least one org exists (principle 1)');

    // ── Every existing user is a member (the backfill) ─────────────────────
    const users = await prisma.user.count();
    const memberless = await prisma.user.count({
      where: { orgMemberships: { none: { orgId: INSTALL_ORG_ID } } },
    });
    check(users > 0, `database has users to check (${users})`);
    check(memberless === 0, `every user is a member of the install org (${memberless} memberless)`);
    const duplicates = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM (
        SELECT "userId" FROM "org_membership" WHERE "orgId" = ${INSTALL_ORG_ID}
        GROUP BY "userId" HAVING COUNT(*) > 1
      ) d`;
    check(Number(duplicates[0]?.n ?? 0) === 0, 'no user holds two install-org memberships');

    // ── The backfill's role rule ───────────────────────────────────────────
    const adminsNotOwner = await prisma.user.count({
      where: {
        ...humanAdminWhere,
        orgMemberships: { some: { orgId: INSTALL_ORG_ID, role: { not: ORG_OWNER_ROLE } } },
      },
    });
    check(adminsNotOwner === 0, 'every real platform admin is an OWNER of the install org');
    const nonAdminOwners = await prisma.orgMembership.count({
      where: {
        orgId: INSTALL_ORG_ID,
        role: ORG_OWNER_ROLE,
        user: { NOT: humanAdminWhere },
      },
    });
    check(nonAdminOwners === 0, 'nobody who is not a real platform admin is an OWNER');
    const serviceOwners = await prisma.orgMembership.count({
      where: { orgId: INSTALL_ORG_ID, role: ORG_OWNER_ROLE, user: serviceAccountWhere },
    });
    check(serviceOwners === 0, 'the SERVICE config-owner is not an OWNER (MEMBER at most)');

    // ── A user created now gets a membership (the hook's write path) ───────
    const member = await prisma.user.create({
      data: { name: `${PREFIX} member`, email: `${PREFIX}-${stamp}@example.com` },
    });
    memberUserId = member.id;
    await ensureMembership(member.id, initialMembershipFor(member));
    const membership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId: member.id } },
    });
    check(membership !== null, 'ensureMembership() wrote the new user’s install-org membership');
    check(membership?.role === DEFAULT_ORG_ROLE, 'a regular user is a MEMBER');
    // Idempotent: a second call neither throws nor changes the row.
    await ensureMembership(member.id, { orgId: INSTALL_ORG_ID, role: ORG_OWNER_ROLE });
    const again = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId: member.id } },
    });
    check(
      again?.id === membership?.id && again?.role === DEFAULT_ORG_ROLE,
      'a second ensureMembership() is a no-op — the existing row and its role stand'
    );

    // ── Credentials are bound to the install org ───────────────────────────
    // A row created without an orgId today (t-673 starts writing it at mint)
    // is what the backfill saw; prove the column, index and FK accept the
    // install org and that a non-admin key on the live DB carries it.
    const key = await prisma.aiApiKey.create({
      data: {
        userId: member.id,
        name: `${PREFIX} key`,
        keyHash: `${PREFIX}-${stamp}`,
        keyPrefix: 'sk_smoke',
        scopes: ['chat'],
        orgId: INSTALL_ORG_ID,
      },
    });
    apiKeyId = key.id;
    check(key.orgId === INSTALL_ORG_ID, 'an API key can be bound to the install org');

    // The backfill rule, proven on a population this run creates rather than
    // asserted absent on whatever the table holds (which may be nothing): two
    // unbound keys, one `chat` and one `admin`, then the migration's OWN
    // UPDATE statement — read from the file, so the smoke cannot drift from
    // the SQL it vouches for. The chat key binds; the admin key stays NULL.
    const chatKey = await prisma.aiApiKey.create({
      data: {
        userId: member.id,
        name: `${PREFIX} chat key`,
        keyHash: `${PREFIX}-chat-${stamp}`,
        keyPrefix: 'sk_smoke',
        scopes: ['chat'],
      },
    });
    chatKeyId = chatKey.id;
    const adminKey = await prisma.aiApiKey.create({
      data: {
        userId: member.id,
        name: `${PREFIX} admin key`,
        keyHash: `${PREFIX}-admin-${stamp}`,
        keyPrefix: 'sk_smoke',
        scopes: ['admin'],
      },
    });
    adminKeyId = adminKey.id;
    check(
      chatKey.orgId === null && adminKey.orgId === null,
      'two keys created unbound (orgId NULL)'
    );
    const migration = readFileSync(
      path.join(process.cwd(), 'prisma/migrations/20260917120000_org_identity/migration.sql'),
      'utf8'
    );
    const backfillUpdate = migration
      .split('\n')
      .find((line) => line.startsWith('UPDATE "ai_api_key"'));
    if (!backfillUpdate)
      throw new Error('could not find the ai_api_key backfill UPDATE in the migration');
    const bound = await prisma.$executeRawUnsafe(backfillUpdate);
    check(
      bound === 1,
      `re-running the migration's ai_api_key backfill bound exactly one row (${bound})`
    );
    const [chatAfter, adminAfter] = await Promise.all([
      prisma.aiApiKey.findUnique({ where: { id: chatKey.id } }),
      prisma.aiApiKey.findUnique({ where: { id: adminKey.id } }),
    ]);
    check(
      chatAfter?.orgId === INSTALL_ORG_ID,
      'the backfill binds a chat-scoped key to the install org'
    );
    check(
      adminAfter?.orgId === null,
      'the backfill leaves an admin-scoped key unbound (a platform credential)'
    );
    check(
      key.orgId === INSTALL_ORG_ID &&
        (await prisma.aiApiKey.findUnique({ where: { id: key.id } }))?.orgId === INSTALL_ORG_ID,
      'a key already bound is not rewritten by the backfill'
    );

    // ── Erasing the user takes the membership, not the org ─────────────────
    await prisma.user.delete({ where: { id: member.id } });
    memberUserId = null;
    apiKeyId = chatKeyId = adminKeyId = null; // cascaded with the user
    check(
      (await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId: member.id } },
      })) === null,
      'membership cascade-deleted with the user'
    );
    check(
      (await prisma.org.findUnique({ where: { id: INSTALL_ORG_ID } })) !== null,
      'the install org survives its member’s deletion'
    );

    console.log('\n✓ smoke:tenancy passed');
  } finally {
    for (const id of [apiKeyId, chatKeyId, adminKeyId]) {
      if (id) await prisma.aiApiKey.deleteMany({ where: { id } }).catch(() => undefined);
    }
    if (memberUserId)
      await prisma.user.deleteMany({ where: { id: memberUserId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().catch(async (err) => {
  console.error('\n✗ smoke:tenancy failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
