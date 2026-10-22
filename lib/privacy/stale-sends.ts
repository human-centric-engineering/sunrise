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
 * **Why the locks, held across the send.** The check alone races an erasure
 * still running: its receipt is not visible until it commits. So the sender
 * takes erasure's advisory lock for everyone the copy names, shared (t-841),
 * and keeps it until the send settles. Whichever gets there first finishes
 * before the other reads: either the send went before the erasure committed,
 * and erasure then redacts the row it left; or the erasure committed first,
 * and the sender sees its receipt. Erasure only tries the locks, and waits
 * outside its transaction when they are busy (t-840). Shared, so two sends to
 * the same person do not wait for each other.
 *
 * The cost is a connection held for the send, and only when the copy names
 * someone: a send naming nobody opens no transaction. It is held for at most
 * {@link SENDER_LOCK_WAIT_MS} waiting for the locks, then the send's timeout.
 * A post that went out and whose transaction then failed to commit is reported
 * as failed and retried, so its receiver may get it twice; an email carries an
 * idempotency key, a webhook or hook post does not.
 *
 * @see lib/orchestration/engine/executors/notification.ts — the same shape,
 *      anchored on the run's start (t-841)
 * @see .context/privacy/data-erasure.md — "Writers of scrubbed data"
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import {
  anyoneErasedSince,
  boundLockWaits,
  findErasedSubjects,
  namesAnyone,
  type ErasedSubjects,
  type NamedSubjects,
} from '@/lib/privacy/erased-subjects';
import { subjectsOfPayload, withoutErasedSubjects } from '@/lib/privacy/delivery-payloads';
import { RECIPIENT_ERASED, SUBJECT_ERASED } from '@/lib/orchestration/webhooks/not-retried';

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
  send: (tx: Prisma.TransactionClient, erased: ErasedSubjects) => Promise<T>
): Promise<T> {
  if (!namesAnyone(subjects)) return send(prisma, NOBODY_ERASED);
  return prisma.$transaction(
    async (tx) => {
      await boundLockWaits(tx, SENDER_LOCK_WAIT_MS);
      const erased = await findErasedSubjects(tx, subjects, { shared: true, since: takenAt });
      return send(tx, erased);
    },
    // maxWait: a connection may be slow to come free while other sends hold
    // theirs; past Prisma's 2 s default that would fail the send (t-841).
    { timeout: SENDER_LOCK_WAIT_MS + sendTimeoutMs + 10_000, maxWait: 10_000 }
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

/**
 * Decide a webhook or event-hook delivery attempt under erasure's locks, and
 * act on the decision inside them (t-886): `act` writes the stop, or stores the
 * redacted payload and sends. The one place both delivery tables decide, so a
 * fix to the rule lands in both.
 *
 * **Which copy.** The attempt holds two: the row's payload, from the event
 * when the row was created (or earlier — a run's memory, from when it
 * started), and the subscription or hook read for this attempt (`takenAt`).
 * Everything is checked against the oldest of them, so a retry days later
 * still counts an erasure that came after its event (code review). That also
 * leaves out an address re-entered on a subscription after an erasure that
 * came after the row's event, until the row is replaced: the safe side.
 *
 * **A payload naming a conversation or run that is gone** is stopped when
 * anyone at all was erased since: its owner may have cascaded away, and can no
 * longer be named. Receipts carry no org, so an erasure anywhere counts; the
 * cost is a delivery about a conversation deleted for another reason, stopped
 * when an erasure happened within minutes of this attempt.
 */
export async function decideDeliveryUnderLocks<T>(
  delivery: HeldDelivery,
  address: string | null,
  takenAt: Date,
  sendTimeoutMs: number,
  act: (tx: Prisma.TransactionClient, decision: DeliveryDecision) => Promise<T>
): Promise<T> {
  const named = await subjectsOfPayload(prisma, delivery.eventType, delivery.payload);
  const since = new Date(
    Math.min(
      takenAt.getTime(),
      delivery.createdAt.getTime(),
      named.runStartedAt?.getTime() ?? Number.POSITIVE_INFINITY
    )
  );
  return sendHoldingSubjects(
    { addresses: address ? [address] : [], userIds: [...named.userIds.keys()] },
    since,
    sendTimeoutMs,
    async (tx, erased) => {
      const recipientErased = address !== null && erased.addresses.includes(address);
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
        return act(tx, {
          kind: 'stop',
          reason: recipientErased ? RECIPIENT_ERASED : SUBJECT_ERASED,
          recipientErased,
          payload,
        });
      }
      return act(tx, { kind: 'send', payload });
    }
  );
}
