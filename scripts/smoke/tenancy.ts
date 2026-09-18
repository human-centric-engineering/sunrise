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
 * And the org lifecycle (t-672), against the same database: an org is
 * created with its OWNER named, a second member added, the last-OWNER guard
 * refuses to demote or remove that owner, the install org refuses suspension
 * and erasure, a SUSPENDED org refuses entry to its own OWNER through the
 * real entry function and admits them again once reinstated, removing a
 * member revokes only the sessions acting in that org, the export bundle
 * names every manifest section, and erasing the org leaves both users' rows
 * standing — the one with an install membership still holding it.
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
import {
  addMember,
  changeMemberRole,
  createOrg,
  OrgLifecycleError,
  removeMember,
  updateOrg,
} from '@/lib/tenancy/lifecycle';
import { enterSessionOrg, isOrgRefusal } from '@/lib/tenancy/entry';
import { exportOrgData } from '@/lib/privacy/export-org';
import { eraseOrg } from '@/lib/privacy/erase-org';
import { ORG_DATA_SOURCES } from '@/lib/privacy/org-sources';

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

/** The call must throw an OrgLifecycleError with exactly this code. */
async function refuses(code: string, fn: () => Promise<unknown>, msg: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    check(
      error instanceof OrgLifecycleError && error.code === code,
      `${msg} (refused with ${code})`
    );
    return;
  }
  throw new Error(`assertion failed: ${msg} — the call was not refused`);
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:tenancy skipped — no database reachable (DATABASE_URL unset or DB down).');
    return;
  }

  let memberUserId: string | null = null;
  let ownerUserId: string | null = null;
  let otherUserId: string | null = null;
  let orgId: string | null = null;
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

    // ── The org lifecycle (t-672) ──────────────────────────────────────────
    const owner = await prisma.user.create({
      data: { name: `${PREFIX} owner`, email: `${PREFIX}-owner-${stamp}@example.com` },
    });
    ownerUserId = owner.id;
    const other = await prisma.user.create({
      data: { name: `${PREFIX} other`, email: `${PREFIX}-other-${stamp}@example.com` },
    });
    otherUserId = other.id;
    // `other` is also an install-org member — the user whose OTHER org must
    // survive the erasure below. `owner` deliberately is not.
    await ensureMembership(other.id, initialMembershipFor(other));

    const org = await createOrg({
      slug: `${PREFIX}-${stamp}`,
      name: `${PREFIX} org`,
      ownerUserId: owner.id,
    });
    orgId = org.id;
    const ownerRow = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: org.id, userId: owner.id } },
    });
    check(
      ownerRow?.role === ORG_OWNER_ROLE,
      'createOrg() names the founding OWNER in the same write'
    );

    const otherRow = await addMember(org.id, other.id, undefined);
    check(
      otherRow.role === DEFAULT_ORG_ROLE,
      'a member added to a non-empty org with no role asked for is a MEMBER'
    );

    await refuses(
      'LAST_OWNER',
      () => changeMemberRole(org.id, owner.id, DEFAULT_ORG_ROLE),
      'the last OWNER cannot be demoted'
    );
    await refuses(
      'LAST_OWNER',
      () => removeMember(org.id, owner.id),
      'the last OWNER cannot be removed'
    );
    await refuses(
      'INSTALL_ORG_IMMUTABLE',
      () => updateOrg(INSTALL_ORG_ID, { status: 'SUSPENDED' }),
      'the install org cannot be suspended'
    );
    await refuses(
      'INSTALL_ORG_IMMUTABLE',
      () => eraseOrg({ orgId: INSTALL_ORG_ID, actorUserId: owner.id }),
      'the install org cannot be erased'
    );
    await refuses(
      'INSTALL_ORG_MEMBERSHIP',
      () => removeMember(INSTALL_ORG_ID, other.id),
      'a user cannot be removed from the install org'
    );

    // Suspension is enforced where a request enters the org: the real entry
    // function, against the real rows, refuses the org's own OWNER while it
    // is SUSPENDED and admits them again once reinstated.
    await updateOrg(org.id, { status: 'SUSPENDED' });
    const whileSuspended = await enterSessionOrg(owner, org.id, null);
    check(
      isOrgRefusal(whileSuspended) && whileSuspended.refused === 'org-suspended',
      'a SUSPENDED org refuses entry to its own OWNER'
    );
    await updateOrg(org.id, { status: 'ACTIVE' });
    const reinstated = await enterSessionOrg(owner, org.id, null);
    check(
      !isOrgRefusal(reinstated) &&
        reinstated.orgId === org.id &&
        reinstated.role === ORG_OWNER_ROLE,
      'a reinstated org admits its OWNER again, with their role'
    );

    // Removing a member revokes the sessions acting in THAT org only.
    const inOrg = await prisma.session.create({
      data: {
        userId: other.id,
        token: `${PREFIX}-in-org-${stamp}`,
        expiresAt: new Date(Date.now() + 60_000),
        activeOrgId: org.id,
      },
    });
    const inInstall = await prisma.session.create({
      data: {
        userId: other.id,
        token: `${PREFIX}-in-install-${stamp}`,
        expiresAt: new Date(Date.now() + 60_000),
        activeOrgId: INSTALL_ORG_ID,
      },
    });
    const removal = await removeMember(org.id, other.id);
    check(removal.revokedSessions === 1, 'removing a member revoked exactly one session');
    check(
      (await prisma.session.findUnique({ where: { id: inOrg.id } })) === null &&
        (await prisma.session.findUnique({ where: { id: inInstall.id } })) !== null,
      'the session acting in the org is gone; the one in the install org stands'
    );
    await addMember(org.id, other.id, DEFAULT_ORG_ROLE);

    // The export names every manifest section, and the roster is the org's.
    const bundle = await exportOrgData({ orgId: org.id, actorUserId: owner.id });
    const sections = new Set([...Object.keys(bundle.data), ...Object.keys(bundle.attributions)]);
    const missingSections = ORG_DATA_SOURCES.map((s) => s.section).filter((s) => !sections.has(s));
    check(
      missingSections.length === 0,
      `the org export carries every manifest section (${ORG_DATA_SOURCES.length})`
    );
    check(
      (bundle.data.members as { userId: string }[])
        .map((m) => m.userId)
        .sort()
        .join() === [owner.id, other.id].sort().join(),
      'the export’s roster is exactly the org’s two members'
    );

    // Erasing the org: memberships and the pointer go, the people stay.
    const pointing = await prisma.session.create({
      data: {
        userId: other.id,
        token: `${PREFIX}-pointing-${stamp}`,
        expiresAt: new Date(Date.now() + 60_000),
        activeOrgId: org.id,
      },
    });
    const erased = await eraseOrg({ orgId: org.id, actorUserId: owner.id });
    orgId = null;
    check(erased.members === 2, 'eraseOrg() reports the two memberships the cascade removed');
    check(
      erased.sessionsCleared === 1,
      'eraseOrg() cleared the one session still acting in the org'
    );
    check((await prisma.org.findUnique({ where: { id: org.id } })) === null, 'the org row is gone');
    check(
      (await prisma.user.count({ where: { id: { in: [owner.id, other.id] } } })) === 2,
      'both users still exist after their org was erased'
    );
    check(
      (await prisma.orgMembership.count({ where: { userId: owner.id } })) === 0,
      'the owner, who belonged only to the erased org, now belongs to none — and keeps the account'
    );
    check(
      (await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: INSTALL_ORG_ID, userId: other.id } },
      })) !== null,
      'the member with an install-org membership still has it'
    );
    check(
      (await prisma.session.findUnique({ where: { id: pointing.id } }))?.activeOrgId === null,
      'the surviving session’s activeOrgId was cleared rather than left dangling'
    );

    console.log('\n✓ smoke:tenancy passed');
  } finally {
    for (const id of [apiKeyId, chatKeyId, adminKeyId]) {
      if (id) await prisma.aiApiKey.deleteMany({ where: { id } }).catch(() => undefined);
    }
    if (orgId) await prisma.org.deleteMany({ where: { id: orgId } }).catch(() => undefined);
    for (const id of [memberUserId, ownerUserId, otherUserId]) {
      if (id) await prisma.user.deleteMany({ where: { id } }).catch(() => undefined);
    }
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
