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
 * The cost is a connection held for the send — bounded by its timeout — and
 * only when the copy names someone: a send naming nobody opens no transaction.
 *
 * @see lib/orchestration/engine/executors/notification.ts — the same shape,
 *      anchored on the run's start (t-841)
 * @see .context/privacy/data-erasure.md — "Writers of scrubbed data"
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import {
  SUBJECT_LOCK_WAIT_MS,
  boundLockWaits,
  findErasedSubjects,
  namesAnyone,
  type ErasedSubjects,
  type NamedSubjects,
} from '@/lib/privacy/erased-subjects';

/** Nobody erased: what a send naming nobody is handed. */
export const NOBODY_ERASED: ErasedSubjects = { addresses: [], userIds: [] };

/**
 * Run `send` holding erasure's locks, shared, for everyone `subjects` names,
 * having found who among them was erased since `takenAt`. `send` gets the
 * transaction, for any write that must commit with the decision — a delivery
 * row recorded as left out — and must finish within `sendTimeoutMs`.
 *
 * A wait for the locks longer than {@link SUBJECT_LOCK_WAIT_MS} (a backup
 * import holds them for its whole transaction) throws, as any failed send
 * would, and the caller's retry takes it from there.
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
      await boundLockWaits(tx, SUBJECT_LOCK_WAIT_MS);
      const erased = await findErasedSubjects(tx, subjects, { shared: true, since: takenAt });
      return send(tx, erased);
    },
    // maxWait: a connection may be slow to come free while other sends hold
    // theirs; past Prisma's 2 s default that would fail the send (t-841).
    { timeout: SUBJECT_LOCK_WAIT_MS + sendTimeoutMs + 10_000, maxWait: 10_000 }
  );
}
