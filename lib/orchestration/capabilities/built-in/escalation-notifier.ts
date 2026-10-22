/**
 * Escalation Notifier
 *
 * Reads escalation config from the orchestration settings singleton and
 * sends email notifications (and optionally a webhook POST) when a
 * conversation is escalated to a human.
 *
 * Called fire-and-forget from `EscalateToHumanCapability.execute()`.
 *
 * The email goes to the list as it was read, which an erasure may overtake
 * before the send: anyone on it erased since is left out (§122 t-886,
 * `lib/privacy/stale-sends.ts`). Someone erased before the read and since
 * added back is on the list on purpose, and is emailed.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { sendEmail } from '@/lib/email/send';
import { EscalationNotification } from '@/emails/escalation-notification';
import { env } from '@/lib/env';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { loggableUrl } from '@/lib/logging/redact-path';
import { describeFetchFailure } from '@/lib/errors/fetch-error';
import { withTimeout } from '@/lib/utils/with-timeout';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';
import { sendHoldingSubjects } from '@/lib/privacy/stale-sends';
import { SUBJECT_LOCK_WAIT_MS } from '@/lib/privacy/erased-subjects';
import { keepRunningAfterResponse } from '@/lib/api/after-response';
// Single implementation, deliberately shared: this used to be a private copy,
// and hardening one while the settings API kept the other is what opened the
// recipient-list data-loss path (#553).
import { parseEscalationConfig } from '@/lib/orchestration/settings';
import type { EscalationConfig } from '@/types/orchestration';

interface EscalationPayload {
  agentId: string;
  agentName?: string;
  userId: string | null;
  conversationId: string | null;
  reason: string;
  priority: 'low' | 'medium' | 'high';
  metadata: Record<string, unknown> | null;
}

/** How long the escalation email may take: the locks it holds are held that long. */
export const ESCALATION_EMAIL_TIMEOUT_MS = 15_000;

const PRIORITY_RANK: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

function meetsPriorityThreshold(
  priority: string,
  filter: EscalationConfig['notifyOnPriority']
): boolean {
  const rank = PRIORITY_RANK[priority] ?? 0;
  switch (filter) {
    case 'all':
      return true;
    case 'medium_and_above':
      return rank >= 2;
    case 'high':
      return rank >= 3;
    default:
      return true;
  }
}

/**
 * Email the escalation to `recipients`, leaving out anyone erased since the
 * list was read at `takenAt`, holding erasure's locks for them until the send
 * settles (t-886). Never throws: a failed email must not stop the webhook.
 */
async function emailLiveRecipients(
  recipients: string[],
  subjectUserId: string | null,
  takenAt: Date,
  message: Pick<Parameters<typeof sendEmail>[0], 'subject' | 'react'>
): Promise<void> {
  try {
    await sendHoldingSubjects(
      { addresses: recipients, userIds: subjectUserId ? [subjectUserId] : [] },
      takenAt,
      ESCALATION_EMAIL_TIMEOUT_MS,
      async (_tx, erased) => {
        // The escalation is about this person's conversation: erased since,
        // the email (their reason, their thread) is not sent, as a delivery
        // about their activity is not (code review round 2).
        if (subjectUserId && erased.userIds.includes(subjectUserId)) {
          logger.warn('Escalation email not sent: the person it is about was erased');
          return;
        }
        const gone = new Set(erased.addresses);
        const kept = recipients.filter((address) => !gone.has(normaliseAddress(address)));
        if (kept.length < recipients.length) {
          // Never the address: it is what was erased.
          logger.warn('Escalation email: left out recipients erased since the list was read', {
            leftOut: recipients.length - kept.length,
          });
        }
        if (kept.length === 0) return;
        const result = await withTimeout(
          ESCALATION_EMAIL_TIMEOUT_MS,
          'Escalation email',
          (signal) => sendEmail({ ...message, to: kept, signal })
        );
        if (!result.success) {
          // A count, not the list: the addresses are personal data, and the
          // log outlives an erasure of any of them.
          logger.warn('Escalation email send failed', {
            error: result.error,
            recipients: kept.length,
          });
        }
      },
      // An escalation is sent once, with no retry, so it waits as long as the
      // notification step does for an erasure or an import to let go (code
      // review round 3). Escalations are rare; the pool cost is not a burst's.
      { lockWaitMs: SUBJECT_LOCK_WAIT_MS }
    );
  } catch (err) {
    // Before the send, nothing went; after it, a transaction that failed to
    // commit may follow an email that did go.
    logger.warn('Escalation email may not have been sent', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Notify configured recipients about an escalation.
 *
 * Reads escalation config from the settings singleton, checks the
 * priority filter, sends emails and optionally POSTs to webhookUrl.
 * All errors are caught and logged — this must never throw.
 */
export function notifyEscalation(payload: EscalationPayload): Promise<void> {
  // Kept alive past the response, as a webhook dispatch is (t-903): the email
  // can wait for an erasure's locks, and a frozen function would drop it.
  const notifying = notify(payload);
  keepRunningAfterResponse(notifying, 'Escalation notification', { agentId: payload.agentId });
  return notifying;
}

async function notify(payload: EscalationPayload): Promise<void> {
  try {
    // Before the read: the list is the copy the email is sent from (t-886).
    const takenAt = new Date();
    const settings = await prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: { escalationConfig: true },
    });

    const config = parseEscalationConfig(settings?.escalationConfig);
    if (!config) return;

    if (!meetsPriorityThreshold(payload.priority, config.notifyOnPriority)) return;

    const agentName = payload.agentName ?? 'Unknown Agent';
    const appUrl = env.BETTER_AUTH_URL ?? env.NEXT_PUBLIC_APP_URL;

    // Send emails. Not awaited before the webhook: the email may wait up to
    // SENDER_LOCK_WAIT_MS for an erasure's locks (t-886), and the on-call
    // webhook must not wait behind it. Never rejects.
    const emailed =
      config.emailAddresses.length > 0
        ? emailLiveRecipients(config.emailAddresses, payload.userId, takenAt, {
            subject: `Escalation (${payload.priority}): ${payload.reason.slice(0, 80)}`,
            react: EscalationNotification({
              agentName,
              reason: payload.reason,
              priority: payload.priority,
              conversationId: payload.conversationId,
              appUrl: appUrl || undefined,
            }),
          })
        : Promise.resolve();
    try {
      // The webhook carries their reason and metadata too: not posted about a
      // person erased since the escalation (code review round 3). Decided
      // under the locks, posted after, as a webhook delivery is.
      const subjectErased =
        payload.userId !== null &&
        (await sendHoldingSubjects({ userIds: [payload.userId] }, takenAt, 0, (_tx, erased) =>
          Promise.resolve(erased.userIds.includes(payload.userId ?? ''))
        ));
      if (subjectErased) {
        logger.warn('Escalation webhook not posted: the person it is about was erased');
      } else {
        await postEscalationWebhook(config, payload, agentName);
      }
    } finally {
      await emailed;
    }
  } catch (err) {
    logger.error('notifyEscalation failed', {
      error: err instanceof Error ? err.message : String(err),
      agentId: payload.agentId,
    });
  }
}

/** The optional webhook POST. */
async function postEscalationWebhook(
  config: EscalationConfig,
  payload: EscalationPayload,
  agentName: string
): Promise<void> {
  if (config.webhookUrl) {
    // Re-check at the point of use, not just at the API boundary (#553).
    // `escalationConfigWriteSchema` rejects an unsafe target on PATCH, but a
    // direct DB write, a restored backup bundle or a value stored before that
    // refine existed reaches here unvalidated — the same reasoning
    // provider-manager applies to `baseUrl`. Skipping only the POST (rather
    // than failing the parse) keeps the emails flowing and leaves the URL
    // visible in the settings form so it can actually be corrected.
    // The flag means "my relay is on infrastructure I control and it is not
    // publicly routable". A same-pod sidecar on loopback fits that exactly —
    // and is a pattern this codebase already supports for LLM providers via
    // `isLocal` — so it opts into both. The guard keeps the two options
    // orthogonal because they are different properties of an address; the
    // product-level flag composes them because they are one operator intent.
    const targetCheck = checkSafeProviderUrl(config.webhookUrl, {
      allowPrivateNetwork: env.ESCALATION_WEBHOOK_ALLOW_PRIVATE,
      allowLoopback: env.ESCALATION_WEBHOOK_ALLOW_PRIVATE,
    });
    if (!targetCheck.ok) {
      logger.warn('Escalation webhook target rejected; skipping the POST', {
        url: loggableUrl(config.webhookUrl),
        reason: targetCheck.reason,
        message: targetCheck.message,
      });
      return;
    }

    try {
      const response = await fetch(config.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'conversation_escalated',
          agentId: payload.agentId,
          agentName,
          conversationId: payload.conversationId,
          reason: payload.reason,
          priority: payload.priority,
          metadata: payload.metadata,
          timestamp: new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(10_000),
        // Refuse redirects (#534/#553). The URL is validated when the config
        // is parsed, not per hop, so following one would POST the escalation
        // payload to a target the guard never saw.
        redirect: 'error',
      });

      if (!response.ok) {
        logger.warn('Escalation webhook returned non-OK', {
          status: response.status,
          url: loggableUrl(config.webhookUrl),
        });
      }
    } catch (err) {
      // `redirect: 'error'` above makes a newly-redirecting endpoint a new
      // failure mode, and undici renders it as a bare "fetch failed" — this
      // warning is the only signal there is, so it must name the cause.
      logger.warn('Escalation webhook call failed', {
        error: describeFetchFailure(err),
        url: loggableUrl(config.webhookUrl),
      });
    }
  }
}
