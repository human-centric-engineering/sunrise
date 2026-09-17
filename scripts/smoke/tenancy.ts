/**
 * Tenancy identity smoke (§106 t-669).
 *
 * Proves, against a real Postgres, the invariant the identity migration and
 * `userCreateAfterHook` establish between them and that no mocked test can
 * reach: the install org exists with the fixed id, EVERY user is a member of
 * it (the backfill, and — on a fresh database — the 001 seed for the
 * config-owner), the seeded SERVICE owner is a MEMBER not an OWNER, a user
 * created now gets a membership too, the migration's credential backfill
 * binds a chat key and leaves an admin key alone, and deleting a user takes
 * their membership with them (Cascade) while the org stands.
 *
 * What it deliberately does NOT assert: that every platform ADMIN on the
 * database is an install-org OWNER. The role mapping is applied at creation
 * (migration or hook) and is not re-synced when an admin later promotes or
 * demotes a user — see the known gaps in `.context/tenancy/identity.md` — so
 * on a dev database with promote/demote history that check would be red for
 * reasons that are not defects in this code. The rule itself is asserted by
 * `tests/unit/lib/tenancy/migration.test.ts`.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-test-tenancy-*` rows and removes them on every path. Never uses
 * unscoped writes or touches seed data: the one raw statement it runs is the
 * migration's own backfill UPDATE, scoped to the two keys this run created.
 *
 * Run with:
 *   npm run smoke:tenancy
 *   npx tsx --env-file=.env.local scripts/smoke/tenancy.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '@/lib/db/client';
import { SYSTEM_USER_EMAIL } from '@/lib/auth/constants';
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

    // ── The seeded config-owner: a member, and never an OWNER ──────────────
    // Addressed by its fixed email rather than by "every SERVICE account", so
    // the check is about the row the 001 seed writes and cannot go red on an
    // operator's unrelated rows.
    const configOwner = await prisma.user.findUnique({
      where: { email: SYSTEM_USER_EMAIL },
      select: { orgMemberships: { where: { orgId: INSTALL_ORG_ID }, select: { role: true } } },
    });
    if (configOwner) {
      check(
        configOwner.orgMemberships.length === 1,
        'the seeded config-owner is a member of the install org'
      );
      check(
        configOwner.orgMemberships[0]?.role === DEFAULT_ORG_ROLE,
        'the seeded config-owner is a MEMBER, not an OWNER'
      );
    } else {
      console.log(
        '  – no seeded config-owner on this database (db:seed not run); skipping its checks'
      );
    }

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
    // the SQL it vouches for — SCOPED to those two ids. Unscoped, it would
    // also bind every key an operator has minted since the migration (nothing
    // writes orgId at mint until t-673), rewriting rows this smoke does not
    // own and failing its own count. The chat key binds; the admin key stays
    // NULL.
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
    if (!backfillUpdate.endsWith(';'))
      throw new Error('backfill UPDATE does not end with ";" — cannot scope it');
    // All three fixture keys are in the statement's reach — including the one
    // already bound — so "not rewritten" below is a claim the UPDATE could
    // falsify, not one it never touched.
    const scopedUpdate = `${backfillUpdate.slice(0, -1)} AND "id" IN ($1, $2, $3);`;
    const bound = await prisma.$executeRawUnsafe(scopedUpdate, chatKey.id, adminKey.id, key.id);
    check(
      bound === 1,
      `re-running the migration's ai_api_key backfill over the three fixture keys bound exactly one (${bound})`
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
