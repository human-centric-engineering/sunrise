/**
 * Sending from a copy taken before an erasure (§122 t-886).
 *
 * A webhook dispatch reads the subscriptions and builds its payload from an
 * event; an escalation reads the settings, then emails. An erasure that
 * commits in between has already scrubbed the rows those copies came from, so
 * the send would put the person back: an email to the erased address, or a
 * delivery row naming them that erasure's own pass ran too early to see. A
 * sent email cannot be recalled, so sending is strict.
 *
 * So a sender asks, in a transaction it holds until the send has settled:
 * **who that this copy names was erased since it was taken?** — the
 * `taken-at` anchor of `lib/privacy/stale-writers.ts`. Not "ever erased": a
 * person erased before the copy was taken is not in it, so a copy naming them
 * was written after the erasure, on purpose — an address re-entered as a
 * contact — and is sent like any other.
 *
 * **Why the locks.** The check alone races an erasure still running: its
 * receipt is not visible until it commits. So the sender takes erasure's
 * advisory lock for everyone the copy names, shared (t-841), and decides —
 * and writes what it decided — under them. Whichever gets there first
 * finishes before the other reads: either the decision committed first, and
 * an erasure then redacts the row it left; or the erasure committed first, and
 * the sender sees its receipt. Erasure only tries the locks, and waits outside
 * its transaction when they are busy (t-840). Shared, so two sends to the
 * same person do not wait for each other.
 *
 * **An email is sent under the locks**; a webhook or hook post after the
 * decision commits (owner ruling, 2026-10-22). An email reaches the person and
 * cannot be recalled, so it holds them until it settles, as the notification
 * step does. A post goes to a third party, and holding a pooled connection
 * across its response let a burst of retries starve the pool (code review
 * round 2); an erasure in the moment between still redacts the stored row.
 *
 * The cost is a connection held for at most {@link SENDER_LOCK_WAIT_MS}
 * waiting for the locks, plus an email's send, and only when the copy names
 * someone: a send naming nobody opens no transaction.
 *
 * @see lib/orchestration/engine/executors/notification.ts — the same shape,
 *      anchored on the run's start (t-841)
 * @see .context/privacy/data-erasure.md — "Writers of scrubbed data"
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  anyoneErasedSince,
  boundLockWaits,
  findErasedSubjects,
  matchErasedSubjects,
  namesAnyone,
  type ErasedSubjects,
  type NamedSubjects,
} from '@/lib/privacy/erased-subjects';
import {
  subjectsOfPayload,
  withoutErasedSubjects,
  type PayloadSubjects,
} from '@/lib/privacy/delivery-payloads';
import {
  AWAITING_RETRY_STATUSES,
  RECIPIENT_ERASED,
  SUBJECT_ERASED,
  notRetried,
} from '@/lib/orchestration/webhooks/not-retried';

/**
 * How long a sender waits for erasure's locks before giving up on this attempt
 * (code review, t-886). An erasure holds them for its transaction (60 s), a
 * backup import for its whole import (130 s); a delivery waiting that long
 * would hold a pooled connection all the while, on the chat path among others.
 * Given up, the attempt fails as any failed send does and its retry asks again.
 */
export const SENDER_LOCK_WAIT_MS = 30_000;

/** Nobody erased: what a send naming nobody is handed. */
export const NOBODY_ERASED: ErasedSubjects = { addresses: [], userIds: [] };

/**
 * Run `send` holding erasure's locks, shared, for everyone `subjects` names,
 * having found who among them was erased since `takenAt`. `send` gets the
 * transaction, for any write that must commit with the decision — a delivery
 * row recorded as left out — and must finish within `sendTimeoutMs`.
 *
 * A wait for the locks longer than {@link SENDER_LOCK_WAIT_MS} throws, as any
 * failed send would, and the caller's retry takes it from there.
 */
export async function sendHoldingSubjects<T>(
  subjects: NamedSubjects,
  takenAt: Date,
  sendTimeoutMs: number,
  send: (tx: Prisma.TransactionClient, erased: ErasedSubjects) => Promise<T>,
  { lockWaitMs = SENDER_LOCK_WAIT_MS }: { lockWaitMs?: number } = {}
): Promise<T> {
  if (!namesAnyone(subjects)) return send(prisma, NOBODY_ERASED);
  return prisma.$transaction(
    async (tx) => {
      await boundLockWaits(tx, lockWaitMs);
      const erased = await findErasedSubjects(tx, subjects, { shared: true, since: takenAt });
      return send(tx, erased);
    },
    // maxWait: a connection may be slow to come free while other sends hold
    // theirs; past Prisma's 2 s default that would fail the send (t-841).
    { timeout: lockWaitMs + sendTimeoutMs + 10_000, maxWait: 10_000 }
  );
}

/** A delivery row about to be attempted: what the check reads off it. */
export interface HeldDelivery {
  eventType: string;
  /** The row's payload: the copy it was created from, or what a retry's claim returned. */
  payload: Prisma.JsonValue;
  createdAt: Date;
}

/** What to do with a delivery attempt, decided under the locks. */
export type DeliveryDecision =
  | {
      /** Not sent. Settle the row as erasure stops one (t-793). */
      kind: 'stop';
      reason: typeof RECIPIENT_ERASED | typeof SUBJECT_ERASED;
      /** The address was erased: take it off the row. */
      recipientErased: boolean;
      /** The payload redacted, or null when it names nobody erased. */
      payload: Prisma.JsonValue | null;
    }
  | {
      kind: 'send';
      /** Send this instead, and store it: an admin who acted, taken out. Null: unchanged. */
      payload: Prisma.JsonValue | null;
    };

/** How {@link decideDeliveryUnderLocks} sends. */
export interface DeliverySendOptions {
  /** How long the send may take, when it is held under the locks. */
  sendTimeoutMs: number;
  /**
   * Send inside the transaction, holding the locks until it settles: for an
   * email, which reaches the person and cannot be recalled. A webhook or hook
   * post is sent after the decision commits (owner ruling, 2026-10-22, t-886):
   * no pooled connection is held across a third party's HTTP response, and an
   * erasure committing in the moment between still redacts the stored row —
   * the receiver gets an event decided a moment before it.
   */
  holdAcrossSend: boolean;
  /**
   * Who the row's payload names, when the caller has already resolved it: an
   * event's first attempts share one payload, so its fan-out resolves it once
   * (t-926). A retry leaves it out, and it is resolved from the row it
   * claimed, which an erasure may have redacted since.
   */
  subjects?: PayloadSubjects;
}

/**
 * Who an event's payload names, resolved once for its whole fan-out (t-926):
 * each first attempt's row is created from this same payload. Start it before
 * the rows are written and await it after each, so a slow lookup never keeps
 * a delivery from being recorded. A failed lookup is logged and resolves to
 * undefined: each attempt then looks up for itself, as before t-926.
 */
export function resolveFanOutSubjects(
  eventType: string,
  payload: Prisma.JsonValue,
  sender: 'Webhook' | 'Hook'
): Promise<PayloadSubjects | undefined> {
  return subjectsOfPayload(prisma, eventType, payload).catch((err: unknown) => {
    logger.warn(
      `${sender} dispatch: could not resolve who the payload names once; each attempt will`,
      {
        eventType,
        error: err instanceof Error ? err.message : String(err),
      }
    );
    return undefined;
  });
}

/** The delivery tables a stopped attempt is settled in. */
export type DeliveryTable = 'webhook' | 'hook';

/**
 * Settle a delivery attempt a sender did not send (t-886): `exhausted`,
 * `stoppedByErasure`, so no retry or replay sends it, the not-retried reason
 * appended to its error, and its payload redacted when there is one. Only a
 * row still waiting to send is written: one already settled stays as it is.
 * `extra` is what one table also clears (the webhook row's address, when that
 * is what was erased). The one place a sender writes a stop, for both
 * delivery tables (t-926); erasure's own pass over the rows writes its stop
 * in `erase-user.ts`.
 */
export async function settleStoppedDelivery(
  tx: Pick<Prisma.TransactionClient, 'aiWebhookDelivery' | 'aiEventHookDelivery'>,
  table: DeliveryTable,
  record: { id: string; lastError: string | null },
  stop: {
    reason: typeof RECIPIENT_ERASED | typeof SUBJECT_ERASED;
    payload: Prisma.JsonValue | null;
  },
  extra: { destination?: string; destinationFingerprint?: null } = {}
): Promise<void> {
  const where = { id: record.id, status: { in: [...AWAITING_RETRY_STATUSES] } };
  const payload = stop.payload;
  const data = {
    status: 'exhausted',
    nextRetryAt: null,
    stoppedByErasure: true,
    lastError: notRetried(record.lastError, stop.reason),
    ...(payload !== null ? { payload } : {}),
    ...extra,
  };
  if (table === 'webhook') await tx.aiWebhookDelivery.updateMany({ where, data });
  else await tx.aiEventHookDelivery.updateMany({ where, data });
}

/**
 * Decide a webhook or event-hook delivery attempt under erasure's locks (t-886):
 * `settle` writes the decision in the transaction — the stop, or the redacted
 * payload — and `send` sends what was decided, inside the transaction or after
 * it commits ({@link DeliverySendOptions.holdAcrossSend}). Null when the
 * attempt was stopped. The one place both delivery tables decide, so a fix to
 * the rule lands in both.
 *
 * **Which copy.** The attempt holds two: the row's payload, from the event
 * when the row was created (or earlier — a run's memory, from when it
 * started), and the subscription or hook read for this attempt (`takenAt`).
 * The people the payload names are checked against the oldest of them, so a
 * retry days later still counts an erasure that came after its event (code
 * review). The subscription's address, read for this attempt, is checked
 * against `takenAt` alone, so one re-entered after an older erasure is sent to.
 *
 * **A payload naming a conversation or run that is gone** is stopped when
 * anyone at all was erased since this attempt's read: its owner may have
 * cascaded away, and can no longer be named. Receipts carry no org, so an
 * erasure anywhere counts; the cost is a delivery about a conversation deleted
 * for another reason, stopped when an erasure happened within minutes of this
 * attempt.
 */
export async function decideDeliveryUnderLocks<T>(
  delivery: HeldDelivery,
  address: string | null,
  takenAt: Date,
  options: DeliverySendOptions,
  settle: (tx: Prisma.TransactionClient, decision: DeliveryDecision) => Promise<void>,
  send: (decision: Extract<DeliveryDecision, { kind: 'send' }>) => Promise<T>
): Promise<T | null> {
  const named =
    options.subjects ?? (await subjectsOfPayload(prisma, delivery.eventType, delivery.payload));
  const since = new Date(
    Math.min(
      takenAt.getTime(),
      delivery.createdAt.getTime(),
      named.runStartedAt?.getTime() ?? Number.POSITIVE_INFINITY
    )
  );
  type Held =
    | { stopped: true }
    | {
        stopped: false;
        decision: Extract<DeliveryDecision, { kind: 'send' }>;
        sent?: { result: T };
      };
  const held = await sendHoldingSubjects<Held>(
    { addresses: address ? [address] : [], userIds: [...named.userIds.keys()] },
    since,
    options.holdAcrossSend ? options.sendTimeoutMs : 0,
    async (tx, erased) => {
      // The address was read for this attempt, so only an erasure since that
      // read counts against it: one re-entered on the subscription after an
      // older erasure is sent to, however old the event (code review round 3).
      // The locks above cover it; `since` is the older of the two anchors.
      const recipientErased =
        address !== null &&
        erased.addresses.includes(address) &&
        (
          await matchErasedSubjects(tx, { addresses: [address] }, { since: takenAt })
        ).addresses.includes(address);
      // Since this attempt's read, not the row's creation: a retry days later
      // would otherwise count every erasure in the meantime, in any org. A
      // row created in the window erasure's pass missed is caught by its
      // first attempt, whose read is that recent (code review round 2).
      const danglingErased = named.dangling && (await anyoneErasedSince(tx, takenAt));
      const { payload, stop } = withoutErasedSubjects(
        delivery.payload,
        named,
        erased.userIds,
        danglingErased
      );
      if (recipientErased || stop) {
        await settle(tx, {
          kind: 'stop',
          reason: recipientErased ? RECIPIENT_ERASED : SUBJECT_ERASED,
          recipientErased,
          payload,
        });
        return { stopped: true };
      }
      const decision = { kind: 'send' as const, payload };
      await settle(tx, decision);
      if (!options.holdAcrossSend) return { stopped: false, decision };
      return { stopped: false, decision, sent: { result: await send(decision) } };
    }
  );
  if (held.stopped) return null;
  return held.sent ? held.sent.result : send(held.decision);
}
