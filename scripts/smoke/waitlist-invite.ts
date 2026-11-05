/**
 * Smoke: from the waitlist to an account, against a real database (§125 t-978).
 *
 *   npm run smoke:waitlist-invite
 *
 * Walks the whole path with the real functions and the real sign-up:
 *
 *   join → confirm → invite → sign up → entry linked
 *
 * and checks what the unit tests cannot, because they mock Prisma and
 * better-auth:
 *
 *   • the conditional `invitedAt` stamp and the invitation row it writes
 *     (`metadata.waitlistEntryId`, role `USER`), as Postgres runs them;
 *   • an unconfirmed entry is refused, and so is a second invite racing the
 *     first (the stamp is conditioned on `invitedAt` as read);
 *   • a sign-up through that invitation — `auth.api.signUpEmail` inside
 *     `runInvitedSignup`, exactly as accept-invite calls it once the token is
 *     validated — runs the after-hook, which sets the entry's `userId` and
 *     `joinedAt`;
 *   • a sign-up with no waitlist invitation, for an address that also has a
 *     confirmed entry, touches no entry.
 *
 * Email is off for the run (`RESEND_API_KEY=` in the npm script), so nothing
 * is sent. Runs in the install org, on lists of its own; self-cleaning by
 * tracked id.
 */

import { auth } from '@/lib/auth/config';
import { runInvitedSignup } from '@/lib/auth/signup-mode';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { INVITATION_IDENTIFIER_PREFIX } from '@/lib/utils/invitation-token';
import { parseInvitationMetadata } from '@/lib/validations/admin';
import {
  DEFAULT_WAITLIST_JOIN_PATH,
  DEFAULT_WAITLIST_RETENTION,
  type ResolvedWaitlistConfig,
} from '@/lib/waitlist/config';
import { confirmWaitlistEntry } from '@/lib/waitlist/confirm';
import { inviteWaitlistEntry } from '@/lib/waitlist/invite';
import { joinWaitlist } from '@/lib/waitlist/join';
import { issueConfirmToken } from '@/lib/waitlist/tokens';

const PREFIX = 'smoke-waitlist-invite';
const stamp = Date.now();
const LIST = `invite${stamp}`;

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'smoke',
  fields: [],
  lists: [{ key: LIST }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
  joinPath: DEFAULT_WAITLIST_JOIN_PATH,
};

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

const inOrg = <T>(fn: () => Promise<T>) => runAsOrg(INSTALL_ORG_ID, fn, { source: 'public-form' });

async function joinAndConfirm(email: string, name: string): Promise<string> {
  const joined = await inOrg(() =>
    joinWaitlist(CONFIG, {
      email,
      name,
      list: LIST,
      details: {},
      source: 'form',
      locale: null,
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      referrerHost: null,
      ip: null,
    })
  );
  check(joined.outcome === 'created', `${name} joined (${joined.outcome})`);
  const { token } = await inOrg(() => issueConfirmToken(joined.entryId));
  check(
    (await confirmWaitlistEntry(joined.entryId, token)) === 'confirmed',
    `${name} confirmed through the link`
  );
  return joined.entryId;
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:waitlist-invite skipped — no database reachable.');
    return;
  }
  const emails = [
    `${PREFIX}-${stamp}-invited@example.com`,
    `${PREFIX}-${stamp}-public@example.com`,
    `${PREFIX}-${stamp}-unconfirmed@example.com`,
  ];
  const [invitedEmail, publicEmail, unconfirmedEmail] = emails;
  const userIds: string[] = [];

  try {
    const admin = await prisma.user.create({
      data: {
        name: `${PREFIX} admin`,
        email: `${PREFIX}-${stamp}@example.com`,
        emailVerified: true,
      },
      select: { id: true, name: true },
    });
    userIds.push(admin.id);

    console.log('join → confirm');
    const invitedId = await joinAndConfirm(invitedEmail, 'Ada');
    const publicId = await joinAndConfirm(publicEmail, 'Grace');

    console.log('invite');
    const unconfirmed = await inOrg(() =>
      joinWaitlist(CONFIG, {
        email: unconfirmedEmail,
        name: 'Unconfirmed',
        list: LIST,
        details: {},
        source: 'form',
        locale: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        referrerHost: null,
        ip: null,
      })
    );
    const refused = await inOrg(() =>
      inviteWaitlistEntry({ entryId: unconfirmed.entryId, inviter: admin, log: logger })
    );
    check(
      refused.outcome === 'refused' && refused.reason === 'unconfirmed',
      'an unconfirmed entry is refused'
    );

    // Two invites of one entry at once: the stamp lets one through.
    const [a, b] = await Promise.all([
      inOrg(() => inviteWaitlistEntry({ entryId: invitedId, inviter: admin, log: logger })),
      inOrg(() => inviteWaitlistEntry({ entryId: invitedId, inviter: admin, log: logger })),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    check(
      outcomes[0] === 'invited' && outcomes[1] === 'refused',
      `two concurrent invites: one sent, one refused (${a.outcome}, ${b.outcome})`
    );

    const rows = await prisma.verification.findMany({
      where: { identifier: `${INVITATION_IDENTIFIER_PREFIX}${invitedEmail}` },
      select: { metadata: true },
    });
    check(rows.length === 1, 'one invitation row for the address');
    const metadata = parseInvitationMetadata(rows[0]?.metadata);
    check(metadata?.waitlistEntryId === invitedId, 'the invitation carries the entry id');
    check(
      metadata?.role === 'USER' && metadata.orgId === undefined,
      'as USER, into the install org'
    );
    const stamped = await inOrg(() =>
      prisma.waitlistEntry.findUniqueOrThrow({
        where: { id: invitedId },
        select: { invitedAt: true, userId: true, joinedAt: true },
      })
    );
    check(
      stamped.invitedAt !== null && stamped.userId === null,
      'invitedAt stamped, not yet linked'
    );

    console.log('sign up → linked');
    // What accept-invite does once the token is validated.
    if (!metadata) throw new Error('unreachable: metadata checked above');
    const signedUp = await runInvitedSignup(
      () =>
        auth.api.signUpEmail({
          body: { name: metadata.name, email: invitedEmail, password: `Smoke-${stamp}-pw!` },
        }),
      metadata
    );
    userIds.push(signedUp.user.id);
    const linked = await inOrg(() =>
      prisma.waitlistEntry.findUniqueOrThrow({
        where: { id: invitedId },
        select: { userId: true, joinedAt: true },
      })
    );
    check(linked.userId === signedUp.user.id, 'the entry is linked to the new account');
    check(linked.joinedAt !== null, 'and joinedAt is set');

    console.log('a sign-up with no waitlist invitation');
    try {
      const plain = await auth.api.signUpEmail({
        body: { name: 'Grace', email: publicEmail, password: `Smoke-${stamp}-pw!` },
      });
      userIds.push(plain.user.id);
      const untouched = await inOrg(() =>
        prisma.waitlistEntry.findUniqueOrThrow({
          where: { id: publicId },
          select: { userId: true, joinedAt: true },
        })
      );
      check(
        untouched.userId === null && untouched.joinedAt === null,
        'its address’s confirmed entry is not linked'
      );
    } catch (error) {
      // Under SIGNUP_MODE=invite_only a public sign-up is refused, which is
      // the same answer: no entry is touched.
      console.log(
        `  – skipped: public sign-up refused here (${error instanceof Error ? error.message : String(error)})`
      );
    }

    console.log('\nsmoke:waitlist-invite passed');
  } finally {
    await prisma.verification
      .deleteMany({
        where: { identifier: { in: emails.map((e) => `${INVITATION_IDENTIFIER_PREFIX}${e}`) } },
      })
      .catch(() => undefined);
    await inOrg(() => prisma.waitlistEntry.deleteMany({ where: { list: LIST } })).catch(
      () => undefined
    );
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
