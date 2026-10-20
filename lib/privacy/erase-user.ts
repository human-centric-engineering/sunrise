/**
 * Right-to-erasure service (GDPR Art. 17).
 *
 * `prisma.user.delete` triggers the schema's referential actions — personal
 * data cascades away, org config + audit rows are retained with their
 * creator/userId set null (see the `account_deletion_erasure_cascade`
 * migration for the per-table policy). This service wraps that delete with
 * the things the DB cascade structurally cannot do:
 *
 *   1. Scrub residual PII the cascade leaves behind — `clientIp` (an IP
 *      address) on the user's retained admin-audit rows. `SetNull` drops the
 *      `userId` link but not the IP, so we null it before the link is gone.
 *   2. Write an append-only `DataErasureReceipt` for accountability
 *      (Art. 5(2)) without re-introducing PII (opaque id + email hash).
 *   3. Remove the user's stored avatar blobs (object storage, not the DB).
 *   4. Delete the contact-form messages sent from the user's stored address,
 *      when the account has verified it. `ContactSubmission` has no FK to
 *      `User`, so no cascade reaches it.
 *   5. Redact the user's own (verified) address from every webhook delivery
 *      sent to it. Deliveries outlive their subscription (`SetNull`, §109
 *      t-739) as the org's record of where its events went, so a notification
 *      emailed to this person would otherwise keep their address for ever.
 *   6. Redact the user from every webhook and event-hook delivery whose payload
 *      names them — an event about their conversations or workflow runs, or a
 *      change they made (t-783). No FK reaches a payload.
 *   7. Clear the user's (verified) address from every email subscription that
 *      sends to it — a colleague's (t-786) or their own — and deactivate it,
 *      with an audit entry for each. Their own subscriptions outlive them
 *      (`createdBy` is `SetNull` since t-782, so an integration they set up
 *      keeps running); one that emails them would otherwise keep notifying an
 *      erased person.
 *   8. Remove the user from the escalation email list and from every workflow
 *      notification and approval step that names them, in drafts and in every
 *      published version, with an audit entry for each (t-791). Then blank
 *      their address in every schedule's input template (audited), and redact
 *      them from other people's runs — their input, and their trace, where a
 *      run paused at an approval keeps its approvers and notification target
 *      (t-804).
 *
 * The scrub, contact delete, receipt, and user delete run in one transaction
 * so they commit or roll back together. Avatar cleanup runs first as a
 * best-effort side effect (object storage cannot enlist in the DB transaction).
 *
 * With a `deadline` (t-845), the erasure stops at the next safe point once
 * time runs out and throws {@link ErasureDeferredError}; what committed before
 * then stays done, and running it again finishes the rest. See
 * `lib/privacy/erasure-deadline.ts`.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isMultiTenant, runAsSystem } from '@/lib/tenancy/context';
import { contactSubmissionsOf, contactSubmissionsUnder } from '@/lib/privacy/contact-submissions';
import { getErasureCleanupHooks } from '@/lib/privacy/erasure-hooks';
import {
  eraseSubjectFromDeliveries,
  preRedactSubjectFromDeliveries,
} from '@/lib/privacy/delivery-payloads';
import { eraseFromConfigRecipients } from '@/lib/privacy/config-recipients';
import {
  eraseFromRunInputs,
  preRedactSubjectFromRuns,
  redactSubjectFromRunsSince,
} from '@/lib/privacy/run-recipients';
import {
  boundLockWaits,
  lockSubjects,
  subjectEmailHash,
  SubjectLocksBusyError,
  tryLockSubjects,
  waitForSubjectLocks,
} from '@/lib/privacy/erased-subjects';
import {
  checkDeadline,
  deferredIfLate,
  ErasureDeferredError,
  inBoundedTransaction,
  msLeft,
} from '@/lib/privacy/erasure-deadline';
import { invalidateOrchestrationSettingsCache } from '@/lib/orchestration/settings';
import {
  AWAITING_RETRY_STATUSES,
  RECIPIENT_ERASED,
  notRetried,
} from '@/lib/orchestration/webhooks/not-retried';
import {
  ERASED_DESTINATION,
  normaliseAddress,
  redactAddressInHistory,
  webhookDeliveriesAddressedTo,
} from '@/lib/orchestration/webhooks/destination';

export type ErasureReason = 'self_service' | 'admin_action';

export { ErasureDeferredError };

/**
 * How long the erasure transaction may run. Generous on purpose: an erasure is
 * rare, and one that times out is refused outright, so the person stays.
 */
export const ERASURE_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * How many times the erasure transaction runs when a writer holds the
 * person's lock (t-840). All but the last only try the lock and, on a miss,
 * wait for it outside the transaction; the last waits inside.
 */
export const SUBJECT_LOCK_TRIES = 3;

export interface EraseUserParams {
  /** Id of the user to erase. */
  userId: string;
  /**
   * @deprecated Ignored, and no longer needed. The receipt hashes the address
   * stored on the user row, read inside the erasure transaction: a caller's
   * copy can be stale (a cached session that predates an email change), and
   * the receipt would then name an address the account no longer held (t-797).
   * Still accepted so existing callers compile; it will be removed at the next
   * MAJOR.
   */
  userEmail?: string;
  /** Who initiated the erasure (the user themselves, or an admin). */
  actorUserId: string;
  reason: ErasureReason;
  /**
   * When to stop (t-845). Checked before the avatars, each hook, each
   * pre-pass chunk or page, and each try of the transaction; a lock wait or
   * transaction already running is capped at the time left. Once it has
   * passed, {@link ErasureDeferredError} is thrown and the account still
   * exists; what committed before then stays done. Without one, nothing is
   * cut short.
   */
  deadline?: Date;
}

export interface EraseUserResult {
  receiptId: string;
  erasedAt: Date;
}

/**
 * Permanently erase a user, the data that cascades from them, and the residual
 * PII the cascade can't reach; record an erasure receipt. Idempotent only in
 * the sense that a second call throws (the user row is already gone) — callers
 * guard with their own existence/authorization checks first.
 */
export async function eraseUser(params: EraseUserParams): Promise<EraseUserResult> {
  const { userId, actorUserId, reason, deadline } = params;

  // 1. Object-storage blobs (avatars) — best-effort, outside the DB transaction.
  checkDeadline(deadline, 'the avatars');
  const { deleteByPrefix, isStorageEnabled } = await import('@/lib/storage/upload');
  if (isStorageEnabled()) {
    await deleteByPrefix(`avatars/${userId}/`);
  }

  // At `multi`, everything below runs as the audited system scope (§107
  // t-748). A person's rows can sit in several orgs, and the routes call this
  // from inside the session's active org (or, with an admin API key, from
  // none). Core's own deletes need no scope — `user.delete`'s cascades are FK
  // actions, which RLS does not filter, and the audit-log scrub touches a
  // system model — but a fork's hook that clears a tenant-owned table would
  // otherwise reach only the caller's org, or throw "No tenant context". Every
  // hook is handed the `userId` and nothing else, so the bypass widens it to
  // that person's rows in every org. At `single` there is one org and no
  // policy, so nothing is entered: a hook keeps the implicit install org.
  const receipt = isMultiTenant()
    ? await runAsSystem(
        // Whose rows, and who asked: logged before the work, so a failed
        // erasure still leaves its audit line.
        `subject erasure: user ${userId}'s rows in every org, for ${actorUserId}`,
        () => eraseRows(params)
      )
    : await eraseRows(params);

  // Contact messages, deliveries, colleagues' subscriptions and the config that
  // names the user are the things erased by address, id or payload rather than
  // by FK, so they are what the
  // receipt cannot vouch for: log what was taken.
  logger.info('User erased', {
    userId,
    actorUserId,
    reason,
    receiptId: receipt.id,
    contactSubmissionsDeleted: receipt.contactSubmissionsDeleted,
    webhookDeliveriesRedacted: receipt.webhookDeliveriesRedacted,
    webhookPayloadsRedacted: receipt.webhookPayloadsRedacted,
    eventHookPayloadsRedacted: receipt.eventHookPayloadsRedacted,
    subscriptionsDeactivated: receipt.subscriptionsDeactivated,
    escalationListsChanged: receipt.escalationListsChanged,
    workflowsChanged: receipt.workflowsChanged,
    schedulesChanged: receipt.schedulesChanged,
    executionsRedacted: receipt.executionsRedacted,
  });
  // The settings row is cached in-process (#442); a list just rewritten should
  // not be served stale to the settings page.
  if (receipt.escalationListsChanged > 0) invalidateOrchestrationSettingsCache();
  // An unverified address matched nothing, so contact messages sent under it
  // are still there, and only a person can decide whether they were this
  // subject's. The address itself is gone with the user row and is not
  // logged; the operator finds the rows through the receipt's
  // `subjectEmailHash`, which hashes the same trimmed, lower-cased form.
  if (receipt.contactSubmissionsLeft > 0) {
    logger.warn('Contact messages not erased: the account never verified its address', {
      userId,
      receiptId: receipt.id,
      contactSubmissionsLeft: receipt.contactSubmissionsLeft,
    });
  }

  return { receiptId: receipt.id, erasedAt: receipt.erasedAt };
}

/** The hooks and the transaction — at `multi`, as {@link eraseUser} runs them in the system scope. */
async function eraseRows(params: EraseUserParams): Promise<{
  id: string;
  erasedAt: Date;
  contactSubmissionsDeleted: number;
  contactSubmissionsLeft: number;
  /** Rows touched by the delivery redaction; a row can count in two passes. */
  webhookDeliveriesRedacted: number;
  /**
   * Writes to webhook deliveries naming the user (redacted, stopped or
   * marked): the pre-pass's plus the transaction's, so a row both wrote
   * counts twice.
   */
  webhookPayloadsRedacted: number;
  /** The same, for event-hook deliveries. */
  eventHookPayloadsRedacted: number;
  /** Email subscriptions — a colleague's or their own — cleared and deactivated. */
  subscriptionsDeactivated: number;
  /** Settings rows whose escalation list named the user. */
  escalationListsChanged: number;
  /** Workflows with a draft or a published version that named the user. */
  workflowsChanged: number;
  /** Schedules whose input template held the user's address (t-804). */
  schedulesChanged: number;
  /** Other people's runs whose input or trace named the user (t-804). */
  executionsRedacted: number;
}> {
  const { userId, deadline } = params;

  // 1b. App-registered external cleanup (object storage, search indexes, …).
  // Best-effort like the avatar cleanup above: a hook failure is logged and
  // swallowed so app-side trouble can never block the user's erasure.
  for (const hook of getErasureCleanupHooks()) {
    if (!hook.cleanupExternal) continue;
    checkDeadline(deadline, `the ${hook.name} cleanup hook`);
    try {
      await hook.cleanupExternal({ userId });
    } catch (error) {
      logger.error('Erasure cleanup hook (external) failed', {
        userId,
        hook: hook.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 1c. Deliveries whose payload names this person, redacted ahead of the
  // transaction in committed chunks (t-806; owner ruling 2026-10-15). A heavy
  // history no longer fits the transaction's 60 s, and an erasure that times
  // out erases nothing; the transaction's own pass below then writes only what
  // this missed. Here because nothing past this point refuses the erasure, as
  // with the avatars: if the transaction still fails, these payloads stay
  // anonymised and a retried erasure completes the rest. Best-effort, like
  // the hooks above: a failure is logged, and the transaction's pass does the
  // whole job instead.
  const preRedacted = { webhook: 0, hook: 0 };
  for (const table of ['webhook', 'hook'] as const) {
    const stage = `the ${table} delivery pre-pass`;
    checkDeadline(deadline, stage);
    try {
      // Counted per committed chunk: one that throws part-way has still
      // written the chunks before it, which the transaction then skips.
      await preRedactSubjectFromDeliveries(
        prisma,
        table,
        userId,
        (written) => {
          preRedacted[table] += written;
        },
        // With a deadline, each statement in a transaction of its own capped
        // at the time left; each chunk still commits as it goes.
        deadline
          ? (statement) => inBoundedTransaction(prisma, deadline, stage, (tx) => statement(tx))
          : undefined
      );
    } catch (error) {
      // Out of time is not a failure to fall back from: the next attempt
      // carries on from the chunks this one committed.
      if (error instanceof ErasureDeferredError) throw error;
      logger.error('Erasure delivery pre-pass failed; the transaction redacts instead', {
        userId,
        table,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 1d. Other people's runs that name this person (t-804), redacted ahead of
  // the transaction one committed page at a time, for the reason 1c gives:
  // searching a large run table inside the transaction's 60 s would time it
  // out. The transaction's pass then reads only runs written since this
  // started, or not yet finished. Best-effort, like 1c: on a failure the
  // transaction's pass reads every run instead.
  let runsChangedSince: Date | null = null;
  let runsPreRedacted = 0;
  checkDeadline(deadline, 'the run pre-pass');
  try {
    const subjectRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, emailVerified: true },
    });
    if (subjectRow) {
      const address = webhookDeliveriesAddressedTo(subjectRow)
        ? normaliseAddress(subjectRow.email)
        : null;
      runsChangedSince = await preRedactSubjectFromRuns(
        prisma,
        { userId, address },
        (n) => {
          runsPreRedacted += n;
        },
        deadline
      );
    }
  } catch (error) {
    if (error instanceof ErasureDeferredError) throw error;
    runsChangedSince = null;
    logger.error('Erasure run pre-pass failed; the transaction redacts instead', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 2. Scrub residual PII, write the receipt, and delete — atomically.
  //
  // A writer can hold this person's lock: a backup import naming them holds
  // it for the whole import, up to 130 s (t-840). Waiting for it inside the
  // transaction would spend its 60 s, and an erasure that times out erases
  // nothing. So the transaction only tries the lock; on a miss it rolls back,
  // the wait happens outside it, and it runs again. The last try waits inside
  // as before, so a lock that keeps being taken cannot hold the erasure off
  // for good.
  const transactionFrom = new Date();
  for (let attempt = 1; ; attempt += 1) {
    const lastTry = attempt >= SUBJECT_LOCK_TRIES;
    // With a deadline, each try gets only the time left (t-845), and none
    // starts once it has passed: the transaction rolls back whole, so a
    // deferral here leaves the account as the pre-passes left it.
    checkDeadline(deadline, 'the erasure transaction');
    const budgetMs = deadline
      ? Math.min(ERASURE_TRANSACTION_TIMEOUT_MS, msLeft(deadline))
      : ERASURE_TRANSACTION_TIMEOUT_MS;
    try {
      const { runSubject, ...receipt } = await prisma.$transaction(
        (tx) => eraseInTransaction(tx, params, runsChangedSince, lastTry, budgetMs),
        // The delivery match scales with the person's history — every chat event
        // a hook received — so Prisma's 5s default is too short for a heavy user,
        // and a timeout rolls the whole erasure back every time it is tried.
        deadline
          ? { timeout: budgetMs, maxWait: Math.min(2_000, budgetMs) }
          : { timeout: ERASURE_TRANSACTION_TIMEOUT_MS }
      );
      // 3. A running workflow that wrote while the transaction was open, from
      // what it held in memory, to a run the transaction's pass did not lock,
      // found no receipt then (t-843). One more pass over the runs written
      // since, now the receipt is visible to their next writes too. The
      // subject is the one the transaction matched on, so a failed pre-pass
      // lookup does not skip this. Best-effort: the erasure has committed.
      let runsRedactedAfter = 0;
      try {
        const after = await redactSubjectFromRunsSince(prisma, runSubject, transactionFrom);
        runsRedactedAfter = after.redacted;
        if (after.failed > 0) {
          logger.error('Erasure run pass after the commit could not reach every run', {
            userId,
            runsNotReached: after.failed,
            error: after.lastError,
          });
        }
      } catch (error) {
        logger.error('Erasure run pass after the commit failed', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        ...receipt,
        webhookPayloadsRedacted: receipt.webhookPayloadsRedacted + preRedacted.webhook,
        eventHookPayloadsRedacted: receipt.eventHookPayloadsRedacted + preRedacted.hook,
        executionsRedacted: receipt.executionsRedacted + runsPreRedacted + runsRedactedAfter,
      };
    } catch (error) {
      // The last try waited for the locks, so a busy error from it is not
      // ours (a fork's hook can throw one): never retried, or this would not
      // end. Past the deadline, whatever stopped the try is most likely the
      // cap on it, so it is a deferral rather than a failure.
      if (lastTry || !(error instanceof SubjectLocksBusyError)) {
        throw deferredIfLate(error, deadline, 'the erasure transaction');
      }
      // Best-effort, like the pre-passes: if the wait fails, the next try
      // finds out for itself. With a deadline, it waits only for the time
      // left, and the next try's check then defers.
      try {
        await waitForSubjectLocks(
          prisma,
          error.subjects,
          deadline ? { maxWaitMs: msLeft(deadline) } : undefined
        );
      } catch (waitError) {
        // Out of time is not worth an error line: the next try defers.
        if (deadline && msLeft(deadline) <= 0) continue;
        logger.error('Erasure could not wait for a writer holding the person’s lock', {
          userId: params.userId,
          error: waitError instanceof Error ? waitError.message : String(waitError),
        });
      }
    }
  }
}

/**
 * The erasure transaction's work. `waitForLocks` false only tries the
 * person's locks and throws {@link SubjectLocksBusyError} when one is held
 * (t-840); true waits for them, as every try did before. `budgetMs` is the
 * transaction's timeout.
 */
async function eraseInTransaction(
  tx: Prisma.TransactionClient,
  params: EraseUserParams,
  runsChangedSince: Date | null,
  waitForLocks: boolean,
  budgetMs: number
) {
  const { userId, actorUserId, reason, deadline } = params;
  // Every lock wait below, the last try's wait for the person's locks among
  // them, gives up within the transaction's budget: Prisma's timeout alone
  // would leave a waiting statement running past it (review round 3). With a
  // deadline every statement does too (t-845), or one still running would
  // keep the request waiting past it. Measured now, not when the try began:
  // Prisma starts its timeout once it has a connection, so time spent waiting
  // for one would otherwise run past the deadline.
  if (deadline) {
    await boundLockWaits(tx, Math.min(budgetMs, msLeft(deadline)), { statementsToo: true });
  } else {
    await boundLockWaits(tx, budgetMs);
  }

  // The address is read from the user row, as the export reads it, not taken
  // from `userEmail`: a caller's copy can be stale (a cached session that
  // predates an email change).
  const account = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });

  // Every step below that matches the person's address does so on the rule
  // subject access uses (`webhookDeliveriesAddressedTo`): exact on the
  // normalised address, never `ILIKE`, and only for a verified address — an
  // unverified one may be a stranger's inbox. Computed once, from the user row.
  const addressed = webhookDeliveriesAddressedTo(account);
  const address = addressed ? normaliseAddress(account.email) : null;

  // Before anything below reads configuration that names them, or writes
  // anything (t-805): the advisory locks every writer of that configuration
  // takes before it checks for an erasure receipt. Held until this
  // transaction commits — the receipt with it — so a writer that read before
  // the erasure either wrote first (and is stripped below) or waits and is
  // refused. Only tried until the last try (t-840): see `eraseRows`. First, so
  // a try that finds a lock held has nothing to roll back.
  const subjects = { addresses: address ? [address] : [], userIds: [userId] };
  if (waitForLocks) {
    await lockSubjects(tx, subjects);
  } else if (!(await tryLockSubjects(tx, subjects))) {
    throw new SubjectLocksBusyError(subjects);
  }

  // Retained admin-audit rows keep their IP after `userId` is SetNull'd.
  await tx.aiAdminAuditLog.updateMany({
    where: { userId },
    data: { clientIp: null },
  });

  // Other people's pending erasures this person asked for as an admin (t-842)
  // name them in a plain column with no FK, so no `SetNull` reaches it. Cleared
  // here instead; the retrier then records those erasures as the person's own.
  await tx.user.updateMany({
    where: { erasureRequestedBy: userId, id: { not: userId } },
    data: { erasureRequestedBy: null },
  });

  // Contact-form messages are keyed by address alone (no FK), so the
  // cascade below never reaches them. The export hands these same rows to
  // the subject as their personal data, so they go — matched exactly, never
  // case-insensitively: an `ILIKE` here would delete a stranger's messages.
  // Matched on the stored address read above, for the reason given there:
  // a stale one would delete the old address's messages and leave the ones
  // the export calls the subject's. An unverified address matches nothing —
  // the form proves nothing about who typed it, so they may be a stranger's.
  // A system model, so no org scope is needed at either tenancy mode.
  const where = contactSubmissionsOf(account);
  const contacts = where ? await tx.contactSubmission.deleteMany({ where }) : { count: 0 };
  // Unverified: count what is being left, so the warning below fires only
  // when there is something for an operator to look at. Counted, never
  // deleted: nothing says these rows are the subject's.
  const left = where
    ? 0
    : await tx.contactSubmission.count({ where: contactSubmissionsUnder(account.email) });

  // An email subscription that notifies this person (t-786; owner ruling
  // 2026-10-13) — a colleague's, or since t-782 their own, which outlives
  // them (`createdBy` is `SetNull`). Either would keep emailing the erased
  // person and writing the address onto every new delivery. Cleared and
  // deactivated rather than deleted: the integration stays visible to
  // whoever manages it, who can point it somewhere else, and nothing
  // addressed to this person is sent again.
  // A subscription stores the address as typed, so each is normalised here
  // by the same function the deliveries are — compared in code rather than
  // re-implemented in SQL, whose `btrim`/`lower` differ from it on tabs and
  // on non-ASCII case. Email subscriptions are configuration, a handful of
  // rows. First, before the delivery passes, so the window in which a
  // dispatch can still read one as active is as short as it can be.
  //
  // Their OWN subscription to their own account address is cleared even
  // when that address was never verified (review round 2): they set it up
  // to email themselves, so it is theirs either way, and since t-782 it
  // outlives them rather than cascading.
  let subscriptionsDeactivated = 0;
  const ownAddress = normaliseAddress(account.email);
  {
    const candidates = await tx.aiWebhookSubscription.findMany({
      where: {
        channel: 'email',
        emailAddress: { not: null },
        ...(address ? {} : { createdBy: userId }),
      },
      select: { id: true, emailAddress: true, isActive: true, orgId: true, createdBy: true },
    });
    const cleared = candidates.filter((sub) => {
      if (sub.emailAddress === null) return false;
      const to = normaliseAddress(sub.emailAddress);
      return to === address || (sub.createdBy === userId && to === ownAddress);
    });
    if (cleared.length > 0) {
      await tx.aiWebhookSubscription.updateMany({
        where: { id: { in: cleared.map((sub) => sub.id) } },
        data: { emailAddress: null, isActive: false },
      });
      // The audit row names the subscription and its owner, never the
      // address: the log is kept through erasure, and the address is what
      // is being erased.
      await tx.aiAdminAuditLog.createMany({
        data: cleared.map((sub) => ({
          userId: actorUserId,
          action: 'webhook_subscription.recipient_erased',
          entityType: 'webhook_subscription',
          entityId: sub.id,
          entityName: sub.id,
          changes: {
            emailAddress: { from: ERASED_DESTINATION, to: null },
            isActive: { from: sub.isActive, to: false },
          },
          metadata: {
            reason: 'The person this subscription emailed was erased.',
            // Null for the subject's own: their id is what is being erased,
            // and the row is about to lose its creator anyway.
            ownerUserId: sub.createdBy === userId ? null : sub.createdBy,
            orgId: sub.orgId,
          },
        })),
      });
    }
    subscriptionsDeactivated = cleared.length;
  }

  // Webhook deliveries now outlive the subscription that sent them (§109
  // t-739), as the org's record of where its events went. An email-channel
  // delivery records the address it went to, and when that is this person's
  // the record must not keep it — whichever subscription sent it, and
  // whether or not that subscription still exists. Redacted, not deleted:
  // the row stays the org's record that an event was sent. Matched through
  // the same rule subject access uses (`webhookDeliveriesAddressedTo`):
  // exact on the normalised address, never `ILIKE`, and only for a verified
  // address — an unverified one may be a stranger's inbox, whose record
  // this must not touch.
  //
  // Three passes, shaped so the transaction's cost tracks the rare cases
  // rather than the number of notifications the person ever received:
  let webhookDeliveriesRedacted = 0;
  if (addressed && address) {
    // 1. Rows still retrying. Their next attempt would email the erased
    //    person again and write the address back onto the row, so they stop
    //    here — one by one, so each keeps its last real error. Retries are
    //    short-lived, so this is a handful of rows at most.
    const retrying = await tx.aiWebhookDelivery.findMany({
      where: { AND: [addressed, { status: { in: [...AWAITING_RETRY_STATUSES] } }] },
      select: { id: true, destination: true, previousDestinations: true, lastError: true },
    });
    for (const row of retrying) {
      const history = redactAddressInHistory(row.previousDestinations, address);
      // Conditional on the row still retrying, decided at the write (t-793):
      // one an attempt delivered since the read stays delivered, and pass 2
      // still takes the address off it.
      await tx.aiWebhookDelivery.updateMany({
        where: { id: row.id, status: { in: [...AWAITING_RETRY_STATUSES] } },
        data: {
          status: 'exhausted',
          nextRetryAt: null,
          lastError: notRetried(row.lastError, RECIPIENT_ERASED),
          stoppedByErasure: true,
          ...(row.destination === address
            ? { destination: ERASED_DESTINATION, destinationFingerprint: null }
            : {}),
          ...(history ? { previousDestinations: history } : {}),
        },
      });
    }
    // 2. Every other row sent to the address: one statement.
    const current = await tx.aiWebhookDelivery.updateMany({
      where: { destination: address },
      data: { destination: ERASED_DESTINATION, destinationFingerprint: null },
    });
    // 3. Rows the address appears on only as an earlier destination — which
    //    needs a retry to have followed an edited subscription, so is rare.
    //    A JSON array cannot be rewritten in place by `updateMany`.
    const movedOn = await tx.aiWebhookDelivery.findMany({
      where: { previousDestinations: { array_contains: [{ destination: address }] } },
      select: { id: true, previousDestinations: true },
    });
    for (const row of movedOn) {
      const history = redactAddressInHistory(row.previousDestinations, address);
      if (history) {
        await tx.aiWebhookDelivery.update({
          where: { id: row.id },
          data: { previousDestinations: history },
        });
      }
    }
    webhookDeliveriesRedacted = retrying.length + current.count + movedOn.length;
  }

  // Deliveries whose payload names this person (t-783): redacted, not
  // deleted, for the reason above. Matched on their conversations and runs
  // too, which cascade with the user row, so this must run before it goes.
  // Writes only what the pre-pass (1c) did not: a delivery written since,
  // or every row when the pre-pass failed.
  const webhookPayloadsRedacted = await eraseSubjectFromDeliveries(tx, 'webhook', userId);
  const eventHookPayloadsRedacted = await eraseSubjectFromDeliveries(tx, 'hook', userId);

  // The escalation list and workflow notification / approval steps that
  // name this person (t-791; owner rulings 2026-10-14): removed from the
  // draft and every published version, a list they leave empty stays
  // empty, and each change is audited. `address` is null for an unverified
  // account, so only the approver id is matched then. After the delivery
  // passes, the longest part of the transaction, so the configuration rows
  // it locks — the settings singleton among them — are held only until
  // the commit just below, not through them.
  const configRecipients = await eraseFromConfigRecipients(tx, {
    userId,
    address,
    actorUserId,
  });

  // What the definitions became at run time (t-804): a schedule's input
  // template holding their address (blanked, so the step it feeds fails
  // loudly, as above), and other people's runs — their input and trace,
  // where a run paused at an approval keeps its approvers and notification
  // target. Their own runs cascade with the user row and are not read.
  const runRecipients = await eraseFromRunInputs(
    tx,
    { userId, address, actorUserId },
    runsChangedSince
  );

  // App-registered in-transaction scrub. Runs before `tx.user.delete()` so
  // hooks can still match retained rows on `userId`, and atomically with the
  // delete — a throw here rolls the entire erasure back.
  for (const hook of getErasureCleanupHooks()) {
    if (!hook.scrubInTransaction) continue;
    await hook.scrubInTransaction({ tx, userId });
  }

  const created = await tx.dataErasureReceipt.create({
    data: {
      subjectUserId: userId,
      // The stored address, as the contact delete reads it: never the
      // caller's copy, which can be stale (t-797).
      // Non-reversible correlation handle — never the raw email.
      subjectEmailHash: subjectEmailHash(account.email),
      actorUserId,
      reason,
      // Whether erasure matched the address (it does only when verified).
      // A writer refuses an erased address only when this says so, since
      // an unverified one may be a stranger's inbox (t-805).
      metadata: { addressVerified: address !== null },
    },
  });

  // Cascades erase personal data; SetNull de-attributes retained config/audit.
  await tx.user.delete({ where: { id: userId } });

  return {
    ...created,
    contactSubmissionsDeleted: contacts.count,
    contactSubmissionsLeft: left,
    webhookDeliveriesRedacted,
    webhookPayloadsRedacted,
    eventHookPayloadsRedacted,
    subscriptionsDeactivated,
    ...configRecipients,
    ...runRecipients,
    // For the run pass after the commit: who this transaction matched on.
    runSubject: { userId, address },
  };
}
