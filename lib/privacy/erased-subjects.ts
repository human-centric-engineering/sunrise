/**
 * Refusing to write an erased person back into configuration (t-805).
 *
 * Erasure (`eraseUser()`, steps 7–8) removes a person's verified address and
 * id from configuration that names them. A writer that read that configuration
 * *before* the erasure and writes its whole copy back *after* it — an open
 * settings form, a builder tab, a publish or rollback in flight, a webhook edit
 * page, or a backup taken before the erasure — would put them back, with no
 * erasure audit trail. Row locks cannot stop that: the writer's read is long
 * over by the time it writes.
 *
 * So every such writer asks, in the transaction that writes: **does anything I
 * am about to write name a person who has been erased?** The erasure receipt
 * is the record of who that is — `subjectUserId`, and `subjectEmailHash` (the
 * same trimmed, lower-cased form erasure matches on). A writer that would write
 * one back is refused (interactive writers, with a 400 naming the field), or
 * strips it (the backup importer, with a warning).
 *
 * **Why a lock.** A check alone races the erasure: a writer could check, find
 * no receipt, and write after an erasure that had already started — and that
 * erasure's scan, which ran before the write, would not see it. Each side
 * therefore takes a transaction-scoped Postgres advisory lock per address and
 * per user id it touches ({@link lockSubjects}) before it reads: the erasure
 * at the start of its transaction, the writer before its check. Whichever gets
 * there first commits before the other reads, so either the writer sees the
 * receipt, or the erasure sees the write and strips it. Keys are taken in
 * sorted order, so two writers cannot deadlock on each other.
 *
 * **What is refused.**
 *   • A **user id** with a receipt: always. The account is gone; an approver
 *     list naming it is personal data with nothing on the other end.
 *   • An **address** whose hash has a receipt that says erasure matched it as
 *     verified (`metadata.addressVerified`, written since t-805). Erasure never
 *     strips an unverified address — it may be a stranger's inbox — so it is
 *     not refused either; and a receipt written before t-805 does not say, so
 *     it is not refused (the race this closes is minutes wide, not years).
 *   • **Not** an address that a live, verified account now holds: a person
 *     who was erased and later signed up again with the same address may be
 *     notified like anyone else.
 *
 * @see lib/privacy/erase-user.ts — takes the same locks and writes the receipt
 * @see .context/privacy/data-erasure.md — "Writers that read before an erasure"
 */

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { ValidationError } from '@/lib/api/errors';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';

/** The addresses and user ids a write would name. Raw: normalised here. */
export interface NamedSubjects {
  addresses?: Iterable<string>;
  userIds?: Iterable<string>;
}

/** The ones among {@link NamedSubjects} that belong to an erased person. */
export interface ErasedSubjects {
  /**
   * Normalised (`normaliseAddress()`: trimmed, lower-cased), not as the caller
   * spelled them — compare a value against these through `normaliseAddress()`.
   */
  addresses: string[];
  userIds: string[];
}

type LockClient = Pick<Prisma.TransactionClient, '$executeRaw'>;
type CheckClient = LockClient & Pick<Prisma.TransactionClient, 'dataErasureReceipt' | 'user'>;

/**
 * The hash an erasure receipt records for an address (`subjectEmailHash`):
 * SHA-256 of the trimmed, lower-cased form — exactly `normaliseAddress()`, so
 * a receipt and the address a writer sends agree on what "the same address"
 * means.
 */
export function subjectEmailHash(email: string): string {
  return createHash('sha256').update(normaliseAddress(email)).digest('hex');
}

/** Whether a string could be an address at all; anything else is never looked up. */
function looksLikeAddress(value: string): boolean {
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1 && !trimmed.includes('{{');
}

function normalised(subjects: NamedSubjects): { addresses: string[]; userIds: string[] } {
  const addresses = new Set<string>();
  for (const raw of subjects.addresses ?? []) {
    if (looksLikeAddress(raw)) addresses.add(normaliseAddress(raw));
  }
  const userIds = new Set<string>();
  for (const id of subjects.userIds ?? []) if (id) userIds.add(id);
  return { addresses: [...addresses], userIds: [...userIds] };
}

/**
 * Take the transaction-scoped advisory lock for every address and user id in
 * `subjects`, in sorted order. Held until the transaction ends. Called by
 * erasure at its start, and by {@link findErasedSubjects} before it reads.
 */
export async function lockSubjects(tx: LockClient, subjects: NamedSubjects): Promise<void> {
  const { addresses, userIds } = normalised(subjects);
  const keys = [
    ...addresses.map((a) => `sunrise:erased-address:${a}`),
    ...userIds.map((id) => `sunrise:erased-user:${id}`),
  ].sort();
  if (keys.length === 0) return;
  // One round trip for every key. The sorted subquery fixes the order the
  // locks are taken in, so two writers naming the same people cannot
  // deadlock on each other.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(k, 0))
    FROM (SELECT unnest(${keys}::text[]) AS k ORDER BY 1) AS ordered`;
}

/**
 * Which of `subjects` belong to an erased person, under the locks. Call inside
 * the transaction that writes them.
 */
export async function findErasedSubjects(
  tx: CheckClient,
  subjects: NamedSubjects
): Promise<ErasedSubjects> {
  const { addresses, userIds } = normalised(subjects);
  if (addresses.length === 0 && userIds.length === 0) return { addresses: [], userIds: [] };
  await lockSubjects(tx, { addresses, userIds });

  const byHash = new Map(addresses.map((a) => [subjectEmailHash(a), a]));
  const receipts = await tx.dataErasureReceipt.findMany({
    where: {
      OR: [
        ...(byHash.size > 0 ? [{ subjectEmailHash: { in: [...byHash.keys()] } }] : []),
        ...(userIds.length > 0 ? [{ subjectUserId: { in: userIds } }] : []),
      ],
    },
    select: { subjectUserId: true, subjectEmailHash: true, metadata: true },
  });

  const erasedIds = new Set(
    receipts.map((r) => r.subjectUserId).filter((id) => userIds.includes(id))
  );
  const erasedAddresses = new Set<string>();
  for (const receipt of receipts) {
    const address = receipt.subjectEmailHash ? byHash.get(receipt.subjectEmailHash) : undefined;
    if (address && addressWasVerified(receipt.metadata)) erasedAddresses.add(address);
  }

  // A person erased and later signed up again with a verified address is
  // notifiable like anyone else.
  if (erasedAddresses.size > 0) {
    const live = await tx.user.findMany({
      where: {
        emailVerified: true,
        email: { in: [...erasedAddresses], mode: 'insensitive' },
      },
      select: { email: true },
    });
    for (const user of live) erasedAddresses.delete(normaliseAddress(user.email));
  }

  return { addresses: [...erasedAddresses], userIds: [...erasedIds] };
}

/** `metadata.addressVerified === true` on a receipt; anything else is "not known". */
function addressWasVerified(metadata: Prisma.JsonValue): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    metadata.addressVerified === true
  );
}

/**
 * Options for a writer's transaction that calls {@link refuseErasedSubjects}.
 *
 * The check waits on erasure's lock, and an erasure may hold it for its whole
 * transaction — up to `ERASURE_TRANSACTION_TIMEOUT_MS` (60 s, in
 * `lib/privacy/erase-user.ts`). Under Prisma's 5 s default a writer queued
 * behind a slow erasure would time out with a 500 instead of being refused
 * with the 400 the field shows. Ten seconds of headroom past erasure's own
 * limit; `erased-subjects.test.ts` holds the two apart.
 */
export const WRITER_TRANSACTION_OPTIONS = { timeout: 70_000 } as const;

/** The message a refused field carries. */
export const ERASED_SUBJECT_MESSAGE =
  'This names a person whose data was erased. Remove it, or reload to see the current value.';

/**
 * Refuse the write when anything in `subjects` names an erased person: a
 * `ValidationError` (400) whose `details` put {@link ERASED_SUBJECT_MESSAGE}
 * on `field`, so the form shows it beside the value. Call inside the
 * transaction that writes, before the write.
 */
export async function refuseErasedSubjects(
  tx: CheckClient,
  subjects: NamedSubjects,
  field: string
): Promise<void> {
  const erased = await findErasedSubjects(tx, subjects);
  if (erased.addresses.length === 0 && erased.userIds.length === 0) return;
  throw new ValidationError('A recipient belongs to a person whose data was erased', {
    [field]: [ERASED_SUBJECT_MESSAGE],
  });
}

/** Every string in a JSON value, for a free-form one such as a schedule's input template. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((v: unknown) => stringsIn(v));
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((v: unknown) => stringsIn(v));
  }
  return [];
}
