/**
 * Delivery-destination smoke script (§109 t-739).
 *
 * Proves, against a real Postgres, what mocked tests cannot: that a webhook or
 * event-hook delivery records where it was sent, and that the record outlives
 * its sender. The survival half is performed by Postgres (`ON DELETE SET NULL`
 * on the parent FK), not by any line of application code, so only a real
 * database can show it. In order:
 *
 *   1. A webhook delivery records the URL's origin and a keyed fingerprint of
 *      the full one, and neither holds the URL's query secret or path token.
 *   2. Editing the subscription changes nothing on the row; a retry after the
 *      edit records the new destination and keeps the old one in
 *      `previousDestinations`.
 *   3. Erasing the admin who created the subscription deletes the subscription
 *      (its `createdBy` cascade) but not the delivery, whose destination stays.
 *      A retry of that orphan is refused and leaves the row untouched. An
 *      email-channel subscription the admin pointed at their own address keeps
 *      its delivery too, but with the address redacted to `[erased]`.
 *   4. The same for an event hook: the delivery records its URL, and survives
 *      the hook's deletion.
 *   5. The org export carries the orphaned rows without the URL secret.
 *   6. Retention still prunes an orphaned row (backdated to 2000, so the prune
 *      cutoff of roughly 2001 reaches nothing but this script's rows).
 *
 * Outbound HTTP is stubbed in-process: `fetch` never leaves the machine. The
 * subscription and hook listen on an event type no real row uses, so nothing
 * else in the database is dispatched to.
 *
 * Skips cleanly (exit 0) when no database is reachable. Self-cleaning: creates
 * only `smoke-test-delivery-dest-*` rows and removes whatever it created.
 *
 * Run with:
 *   npm run smoke:delivery-destination
 *   npx tsx --env-file=.env.local scripts/smoke/delivery-destination.ts
 */

import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import { ORG_DATA_SOURCES } from '@/lib/privacy/org-sources';
import { SUBJECT_DATA_SOURCES } from '@/lib/privacy/export-sources';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { runAsOrg } from '@/lib/tenancy/context';
import { dispatchWebhookEvent, retryDelivery } from '@/lib/orchestration/webhooks/dispatcher';
import { emitHookEvent, invalidateHookCache } from '@/lib/orchestration/hooks/registry';
import type { HookEventType } from '@/lib/orchestration/hooks/types';
import { fingerprintDestination } from '@/lib/orchestration/webhooks/destination';
import { pruneHookDeliveries, pruneWebhookDeliveries } from '@/lib/orchestration/retention';

const PREFIX = 'smoke-test-delivery-dest';
const stamp = Date.now();

/** Unique per run, so no real subscription or hook matches it. */
const EVENT_TYPE = `${PREFIX}-${stamp}`;

/** A path segment `loggableUrl` collapses, standing in for a URL-borne token. */
const PATH_TOKEN = 'Ab3dEf6hIj9kLm2nOp5qRs8t';
const QUERY_SECRET = `querysecret${stamp}`;
const FIRST_URL = `https://hooks.smoke-test.example/services/${PATH_TOKEN}?token=${QUERY_SECRET}`;
const EDITED_URL = `https://edited.smoke-test.example/in/${PATH_TOKEN}?token=${QUERY_SECRET}`;
const HOOK_URL = `https://hook.smoke-test.example/events/${PATH_TOKEN}?sig=${QUERY_SECRET}`;

/** Status the stubbed `fetch` answers with. */
let fetchStatus = 500;
const realFetch = globalThis.fetch;

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

function holdsNoSecret(value: unknown): boolean {
  const text = JSON.stringify(value);
  return !text.includes(QUERY_SECRET) && !text.includes(PATH_TOKEN);
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the delivery row');
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log(
      'smoke:delivery-destination skipped — no database reachable (DATABASE_URL unset or DB down).'
    );
    return;
  }

  globalThis.fetch = () => Promise.resolve(new Response(null, { status: fetchStatus }));

  let userId: string | null = null;
  let subscriptionId: string | null = null;
  let hookId: string | null = null;
  let emailSubscriptionId: string | null = null;
  let receiptId: string | null = null;
  const webhookDeliveryIds: string[] = [];
  const hookDeliveryIds: string[] = [];

  try {
    const user = await prisma.user.create({
      data: {
        name: `${PREFIX} admin`,
        email: `${PREFIX}-${stamp}@example.com`,
        emailVerified: true,
        role: PLATFORM_ADMIN_ROLE,
      },
    });
    userId = user.id;
    await prisma.orgMembership.create({
      data: { orgId: INSTALL_ORG_ID, userId: user.id, role: ORG_OWNER_ROLE },
    });

    // ── 1. A webhook delivery records where it went ──
    console.log('Webhook delivery:');
    const sub = await prisma.aiWebhookSubscription.create({
      data: {
        url: FIRST_URL,
        secret: `${PREFIX}-secret`,
        events: [EVENT_TYPE],
        description: `${PREFIX} subscription`,
        // One attempt: the failure below exhausts at once, so no retry timer
        // is left running behind the script.
        maxAttempts: 1,
        createdBy: user.id,
      },
    });
    subscriptionId = sub.id;

    fetchStatus = 500;
    await dispatchWebhookEvent(EVENT_TYPE, { smoke: PREFIX });
    const sent = await prisma.aiWebhookDelivery.findFirstOrThrow({
      where: { subscriptionId: sub.id },
    });
    webhookDeliveryIds.push(sent.id);
    check(sent.status === 'exhausted', 'the failed delivery is exhausted (one attempt)');
    check(
      sent.destination === 'https://hooks.smoke-test.example',
      `destination is the URL's origin (${sent.destination})`
    );
    check(
      sent.destinationFingerprint === fingerprintDestination('webhook', FIRST_URL),
      'the fingerprint confirms the exact full URL'
    );
    check(holdsNoSecret(sent), 'the row holds neither the query secret nor the path token');

    // ── 2. Edit, then retry ──
    await prisma.aiWebhookSubscription.update({ where: { id: sub.id }, data: { url: EDITED_URL } });
    const afterEdit = await prisma.aiWebhookDelivery.findUniqueOrThrow({ where: { id: sent.id } });
    check(
      afterEdit.destination === sent.destination &&
        afterEdit.destinationFingerprint === sent.destinationFingerprint,
      'editing the subscription leaves the recorded destination alone'
    );

    fetchStatus = 200;
    check(
      await retryDelivery(sent.id, { awaitDelivery: true }),
      'a retry after the edit is accepted'
    );
    const retried = await prisma.aiWebhookDelivery.findUniqueOrThrow({ where: { id: sent.id } });
    check(retried.status === 'delivered', 'the retry delivered');
    check(
      retried.destination === 'https://edited.smoke-test.example',
      'the row now names the edited destination'
    );
    const previous = retried.previousDestinations;
    check(
      Array.isArray(previous) &&
        previous.length === 1 &&
        JSON.stringify(previous[0]).includes(sent.destinationFingerprint ?? '<none>'),
      'the first destination is kept in previousDestinations'
    );
    check(holdsNoSecret(retried), 'neither destination leaks the secret');

    // An email-channel subscription to the admin's own address, in a different
    // case, so the redaction's case-insensitive match is what is tested. The
    // attempt fails and exhausts at once either way: with email unconfigured
    // it is terminal, and with a Resend key set the SDK's request meets the
    // stubbed `fetch` (500), so nothing is sent. The destination is recorded
    // at create regardless.
    const emailSub = await prisma.aiWebhookSubscription.create({
      data: {
        channel: 'email',
        emailAddress: user.email.toUpperCase(),
        events: [EVENT_TYPE],
        description: `${PREFIX} self-notify`,
        maxAttempts: 1,
        createdBy: user.id,
      },
    });
    emailSubscriptionId = emailSub.id;
    await prisma.aiWebhookSubscription.update({
      where: { id: sub.id },
      data: { isActive: false },
    });
    await dispatchWebhookEvent(EVENT_TYPE, { smoke: PREFIX });
    const selfNotified = await prisma.aiWebhookDelivery.findFirstOrThrow({
      where: { subscriptionId: emailSub.id },
    });
    webhookDeliveryIds.push(selfNotified.id);
    check(
      selfNotified.destination === user.email.toLowerCase(),
      'an email-channel delivery records the address, normalised'
    );
    const subjectSource = SUBJECT_DATA_SOURCES.find((s) => s.section === 'notificationsSentToYou');
    if (!subjectSource) throw new Error('no subject source for notificationsSentToYou');
    const theirs = await subjectSource.fetch({
      userId: user.id,
      email: user.email,
      emailVerified: true,
    });
    check(
      theirs.some(
        (r) => typeof r === 'object' && r !== null && 'id' in r && r.id === selfNotified.id
      ),
      'the subject-access export finds the notification emailed to them'
    );
    check(
      !theirs.some((r) => typeof r === 'object' && r !== null && 'payload' in r),
      'without its event payload'
    );

    // ── 3. Erase the creator: the subscription goes, the delivery stays ──
    console.log('Erasing the subscription creator:');
    const erased = await eraseUser({
      userId: user.id,
      userEmail: user.email,
      actorUserId: user.id,
      reason: 'self_service',
    });
    receiptId = erased.receiptId;
    userId = null;
    const subAfter = await prisma.aiWebhookSubscription.findUnique({ where: { id: sub.id } });
    check(subAfter === null, 'the subscription was deleted with its creator');
    subscriptionId = null;
    const orphan = await prisma.aiWebhookDelivery.findUnique({ where: { id: sent.id } });
    check(orphan !== null, 'the delivery survived');
    check(orphan?.subscriptionId === null, 'its subscription link is now null');
    check(orphan?.destination === retried.destination, 'its destination is intact');
    emailSubscriptionId = null;
    const redacted = await prisma.aiWebhookDelivery.findUnique({
      where: { id: selfNotified.id },
    });
    check(redacted !== null, 'the self-notify delivery survived too');
    check(
      redacted?.destination === '[erased]' && redacted.destinationFingerprint === null,
      'but the erased person’s own address and its fingerprint are redacted'
    );

    const orphanRetry = await retryDelivery(sent.id, { awaitDelivery: true });
    const afterOrphanRetry = await prisma.aiWebhookDelivery.findUniqueOrThrow({
      where: { id: sent.id },
    });
    check(!orphanRetry, 'a retry of the orphaned delivery is refused');
    check(
      afterOrphanRetry.status === retried.status && afterOrphanRetry.attempts === retried.attempts,
      'the refused retry leaves the row untouched'
    );

    // ── 4. Event hook ──
    console.log('Event-hook delivery:');
    const hook = await prisma.aiEventHook.create({
      data: {
        name: `${PREFIX} hook`,
        eventType: EVENT_TYPE,
        action: { type: 'webhook', url: HOOK_URL },
      },
    });
    hookId = hook.id;
    invalidateHookCache();
    fetchStatus = 200;
    // The registry's event type is a closed union; this run's own type is
    // deliberately outside it so that no real hook in the database matches.
    emitHookEvent(EVENT_TYPE as HookEventType, { smoke: PREFIX });
    const hookDelivery = await waitFor(
      () => prisma.aiEventHookDelivery.findFirst({ where: { hookId: hook.id } }),
      (row) => row?.status === 'delivered'
    );
    if (!hookDelivery) throw new Error('no hook delivery row');
    hookDeliveryIds.push(hookDelivery.id);
    check(
      hookDelivery.destination === 'https://hook.smoke-test.example',
      `the hook delivery records the URL's origin (${hookDelivery.destination})`
    );
    check(
      hookDelivery.destinationFingerprint === fingerprintDestination('webhook', HOOK_URL),
      'and the fingerprint of the full one'
    );

    await prisma.aiEventHook.delete({ where: { id: hook.id } });
    hookId = null;
    invalidateHookCache();
    const hookOrphan = await prisma.aiEventHookDelivery.findUnique({
      where: { id: hookDelivery.id },
    });
    check(hookOrphan?.hookId === null, 'the hook delivery survived the hook’s deletion');
    check(hookOrphan?.destination === hookDelivery.destination, 'with its destination intact');

    // ── 5. The org export ──
    console.log('Org export:');
    const exported: unknown[] = [];
    for (const section of ['webhookDeliveries', 'eventHookDeliveries']) {
      const source = ORG_DATA_SOURCES.find((s) => s.section === section);
      if (!source?.fetch) throw new Error(`no org source for ${section}`);
      const rows = await source.fetch({ orgId: INSTALL_ORG_ID });
      exported.push(
        ...rows.filter(
          (r) =>
            typeof r === 'object' &&
            r !== null &&
            'id' in r &&
            [sent.id, hookDelivery.id].includes(String(r.id))
        )
      );
    }
    check(exported.length === 2, 'both orphaned deliveries are in the org export');
    check(holdsNoSecret(exported), 'the exported rows hold no URL secret');

    // ── 6. Retention reaches orphans ──
    console.log('Retention:');
    const longAgo = new Date('2000-01-01T00:00:00.000Z');
    await prisma.aiWebhookDelivery.update({ where: { id: sent.id }, data: { createdAt: longAgo } });
    await prisma.aiEventHookDelivery.update({
      where: { id: hookDelivery.id },
      data: { createdAt: longAgo },
    });
    // 9000 days puts the cutoff in mid-2001: only rows this script backdated
    // can be older than that.
    await pruneWebhookDeliveries(9000, 9000);
    await pruneHookDeliveries(9000);
    check(
      (await prisma.aiWebhookDelivery.findUnique({ where: { id: sent.id } })) === null,
      'an orphaned webhook delivery is pruned by age'
    );
    check(
      (await prisma.aiEventHookDelivery.findUnique({ where: { id: hookDelivery.id } })) === null,
      'an orphaned hook delivery is pruned by age'
    );

    console.log('\nsmoke:delivery-destination passed');
  } finally {
    globalThis.fetch = realFetch;
    // Scoped cleanup: only the ids this run created.
    if (webhookDeliveryIds.length > 0) {
      await prisma.aiWebhookDelivery.deleteMany({ where: { id: { in: webhookDeliveryIds } } });
    }
    if (hookDeliveryIds.length > 0) {
      await prisma.aiEventHookDelivery.deleteMany({ where: { id: { in: hookDeliveryIds } } });
    }
    if (hookId) await prisma.aiEventHook.delete({ where: { id: hookId } }).catch(() => undefined);
    if (emailSubscriptionId) {
      await prisma.aiWebhookSubscription
        .delete({ where: { id: emailSubscriptionId } })
        .catch(() => undefined);
    }
    if (subscriptionId) {
      await prisma.aiWebhookSubscription
        .delete({ where: { id: subscriptionId } })
        .catch(() => undefined);
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    if (receiptId) await prisma.dataErasureReceipt.deleteMany({ where: { id: receiptId } });
  }
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
