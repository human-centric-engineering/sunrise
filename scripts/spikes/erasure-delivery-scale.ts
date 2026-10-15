/**
 * Erasure cost for a heavy delivery history (t-793, t-806): how long
 * `eraseUser()` takes when the person's events fill the webhook and event-hook
 * delivery tables. Measurement, not a check.
 *
 * Since t-806 `eraseUser()` redacts the deliveries in committed chunks before
 * its transaction (`preRedactSubjectFromDeliveries`, no time limit), and the
 * transaction's own pass, which has `ERASURE_TRANSACTION_TIMEOUT_MS` (60 s),
 * then writes only what that missed. The spike runs the pre-pass itself first
 * and times it, then times `eraseUser()`. That second figure is an upper
 * bound on the transaction: it also includes `eraseUser()`'s own pre-pass,
 * which here only re-matches, since there is nothing left to change. The
 * transaction itself fitted if the erasure did not throw. This seeds, per
 * size:
 *
 *   - one subject with `size / 10` conversations;
 *   - `size` deliveries in EACH table naming them: a `message.created`-shaped
 *     payload carrying their `userId` and one of those conversations, with a
 *     few hundred bytes of text, 1 in 20 still retrying;
 *   - `size` deliveries in each table naming someone else, so the GIN index
 *     has other rows in it;
 *
 * then times the whole `eraseUser()` and removes every row it created.
 * Run it against a dev or throwaway database, never production:
 *
 *   npx tsx --env-file=.env.local scripts/spikes/erasure-delivery-scale.ts 1000,10000,50000
 *
 * Findings go in `.context/privacy/data-erasure.md` (step 6); this output is
 * not read later.
 */

import { performance } from 'node:perf_hooks';
import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import {
  deliveriesNamingSubject,
  preRedactSubjectFromDeliveries,
} from '@/lib/privacy/delivery-payloads';
import { ERASURE_TRANSACTION_TIMEOUT_MS } from '@/lib/privacy/erase-user';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { runAsOrg } from '@/lib/tenancy/context';

const PREFIX = 'spike-erasure-scale';

const sizes = (process.argv[2] ?? '1000,10000')
  .split(',')
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0);

/** A few hundred bytes of chat-ish text, as a real event would carry. */
const FILLER = 'The customer asked about the refund policy for annual plans. '.repeat(5);

async function seedTable(
  table: 'ai_webhook_delivery' | 'ai_event_hook_delivery',
  tag: string,
  count: number,
  userId: string,
  conversationIds: string[]
): Promise<void> {
  // One statement per table: generate_series, so seeding is not what is timed.
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${table} (id, "eventType", payload, status, attempts, "nextRetryAt", "createdAt", "orgId")
     SELECT $1 || '-' || i,
            'message.created',
            jsonb_build_object(
              'eventType', 'message.created',
              'timestamp', now(),
              'data', jsonb_build_object(
                'userId', $2::text,
                'conversationId', ($3::text[])[1 + (i % cardinality($3::text[]))],
                'agentId', 'agent-x',
                'role', 'user',
                'content', $4::text || i
              )
            ),
            CASE WHEN i % 20 = 0 THEN 'failed' ELSE 'delivered' END,
            1,
            CASE WHEN i % 20 = 0 THEN now() + interval '1 hour' ELSE NULL END,
            now() - (i || ' seconds')::interval,
            $5
       FROM generate_series(1, $6::int) AS i`,
    `${PREFIX}-${tag}`,
    userId,
    conversationIds,
    FILLER,
    INSTALL_ORG_ID,
    count
  );
}

async function measure(size: number): Promise<void> {
  const stamp = Date.now();
  const userIds: string[] = [];
  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        name: `${PREFIX} ${label}`,
        email: `${PREFIX}-${label}-${stamp}@example.com`,
        emailVerified: true,
        role: PLATFORM_ADMIN_ROLE,
      },
    });
    userIds.push(user.id);
    await prisma.orgMembership.create({
      data: { orgId: INSTALL_ORG_ID, userId: user.id, role: ORG_OWNER_ROLE },
    });
    return user;
  };
  const tags = [`s${stamp}`, `o${stamp}`];
  try {
    const subject = await makeUser('subject');
    const other = await makeUser('other');
    const agent = await prisma.aiAgent.findFirstOrThrow({ select: { id: true } });
    const conversationCount = Math.max(1, Math.floor(size / 10));
    await prisma.aiConversation.createMany({
      data: Array.from({ length: conversationCount }, (_, i) => ({
        id: `${PREFIX}-conv-${stamp}-${i}`,
        userId: subject.id,
        agentId: agent.id,
        title: `${PREFIX} ${i}`,
      })),
    });
    const conversationIds = Array.from(
      { length: conversationCount },
      (_, i) => `${PREFIX}-conv-${stamp}-${i}`
    );

    const seedStart = performance.now();
    for (const table of ['ai_webhook_delivery', 'ai_event_hook_delivery'] as const) {
      await seedTable(table, tags[0], size, subject.id, conversationIds);
      await seedTable(table, tags[1], size, other.id, [`${PREFIX}-elsewhere`]);
    }
    // A live table is vacuumed: autovacuum merges GIN's pending list, which
    // `gin_pending_list_limit` (4 MB by default) caps between runs. A bulk
    // seed leaves every row in that list, and each containment probe then
    // scans all of it: 9.6 s instead of 0.7 s for the read at 100,000 rows
    // per table. SPIKE_NO_VACUUM=1 measures that worst case instead.
    if (process.env.SPIKE_NO_VACUUM === '1') {
      await prisma.$executeRawUnsafe('ANALYZE ai_webhook_delivery');
      await prisma.$executeRawUnsafe('ANALYZE ai_event_hook_delivery');
    } else {
      await prisma.$executeRawUnsafe('VACUUM ANALYZE ai_webhook_delivery');
      await prisma.$executeRawUnsafe('VACUUM ANALYZE ai_event_hook_delivery');
    }
    const seedMs = performance.now() - seedStart;

    if (process.env.SPIKE_KEEP === '1') {
      // Leave the seeded rows for EXPLAIN ANALYZE by hand; clean up with
      // SPIKE_CLEAN=1 afterwards.
      console.log(
        `kept: subject ${subject.id}, ids ${PREFIX}-${tags[0]}-*, ${PREFIX}-${tags[1]}-*`
      );
      userIds.length = 0;
      tags.length = 0;
      return;
    }

    // The match on its own, outside any transaction, for comparison: the
    // erasure no longer fetches these rows, but it runs the same match.
    const readStart = performance.now();
    let matched = 0;
    for (const table of ['webhook', 'hook'] as const) {
      matched += (await deliveriesNamingSubject(prisma, table, subject.id)).length;
    }
    const readMs = performance.now() - readStart;

    const preStart = performance.now();
    let preRedacted = 0;
    for (const table of ['webhook', 'hook'] as const) {
      preRedacted += await preRedactSubjectFromDeliveries(prisma, table, subject.id);
    }
    const preMs = performance.now() - preStart;

    const start = performance.now();
    const result = await eraseUser({
      userId: subject.id,
      actorUserId: other.id,
      reason: 'admin_action',
    });
    const eraseMs = performance.now() - start;
    await prisma.dataErasureReceipt.delete({ where: { id: result.receiptId } });
    // Every seeded row naming the subject should now have lost them.
    const redacted = await Promise.all(
      (['ai_webhook_delivery', 'ai_event_hook_delivery'] as const).map(async (table) => {
        const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*) AS n FROM ${table}
            WHERE id LIKE $1 AND payload->'data'->'userId' = 'null'::jsonb
              AND NOT (payload->'data' ? 'content')`,
          `${PREFIX}-${tags[0]}-%`
        );
        return Number(row.n);
      })
    );

    const share = (eraseMs / ERASURE_TRANSACTION_TIMEOUT_MS) * 100;
    console.log(
      [
        `size ${size.toLocaleString()} per table`,
        `(${(size * 2).toLocaleString()} rows naming the subject, ${conversationCount.toLocaleString()} conversations)`,
        `pre-pass ${(preMs / 1000).toFixed(2)} s for ${preRedacted.toLocaleString()} rows`,
        `then erase ${(eraseMs / 1000).toFixed(2)} s = ${share.toFixed(1)}% of the timeout`,
        `read alone ${(readMs / 1000).toFixed(2)} s for ${matched.toLocaleString()} rows`,
        `redacted webhook ${redacted[0].toLocaleString()}, hook ${redacted[1].toLocaleString()}`,
        `(seed ${(seedMs / 1000).toFixed(1)} s)`,
      ].join(' · ')
    );
  } finally {
    for (const table of ['ai_webhook_delivery', 'ai_event_hook_delivery']) {
      for (const tag of tags) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE id LIKE $1`,
          `${PREFIX}-${tag}-%`
        );
      }
    }
    if (tags.length > 0) {
      await prisma.aiConversation.deleteMany({
        where: { id: { startsWith: `${PREFIX}-conv-${stamp}` } },
      });
    }
    // Fixture cleanup, as the erasure smokes do: the subject went through
    // eraseUser() above; these are the seeded bystander and any user a failed
    // run left behind, whose seeded rows are removed by id prefix first.
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
}

/** Remove everything a `SPIKE_KEEP=1` run left behind. */
async function cleanKept(): Promise<void> {
  for (const table of ['ai_webhook_delivery', 'ai_event_hook_delivery']) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table} WHERE id LIKE $1`, `${PREFIX}-%`);
  }
  await prisma.aiConversation.deleteMany({ where: { id: { startsWith: `${PREFIX}-conv-` } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX}-` } } });
}

async function main(): Promise<void> {
  if (process.env.SPIKE_CLEAN === '1') return cleanKept();
  for (const size of sizes) await measure(size);
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
