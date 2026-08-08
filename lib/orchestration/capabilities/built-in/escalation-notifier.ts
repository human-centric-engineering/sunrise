/**
 * Escalation Notifier
 *
 * Reads escalation config from the orchestration settings singleton and
 * sends email notifications (and optionally a webhook POST) when a
 * conversation is escalated to a human.
 *
 * Called fire-and-forget from `EscalateToHumanCapability.execute()`.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { sendEmail } from '@/lib/email/send';
import { EscalationNotification } from '@/emails/escalation-notification';
import { env } from '@/lib/env';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';
import { describeFetchFailure } from '@/lib/errors/fetch-error';
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
 * Notify configured recipients about an escalation.
 *
 * Reads escalation config from the settings singleton, checks the
 * priority filter, sends emails and optionally POSTs to webhookUrl.
 * All errors are caught and logged — this must never throw.
 */
export async function notifyEscalation(payload: EscalationPayload): Promise<void> {
  try {
    const settings = await prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: { escalationConfig: true },
    });

    const config = parseEscalationConfig(settings?.escalationConfig);
    if (!config) return;

    if (!meetsPriorityThreshold(payload.priority, config.notifyOnPriority)) return;

    const agentName = payload.agentName ?? 'Unknown Agent';
    const appUrl = env.BETTER_AUTH_URL ?? env.NEXT_PUBLIC_APP_URL;

    // Send emails
    if (config.emailAddresses.length > 0) {
      const result = await sendEmail({
        to: config.emailAddresses,
        subject: `Escalation (${payload.priority}): ${payload.reason.slice(0, 80)}`,
        react: EscalationNotification({
          agentName,
          reason: payload.reason,
          priority: payload.priority,
          conversationId: payload.conversationId,
          appUrl: appUrl || undefined,
        }),
      });

      if (!result.success) {
        logger.warn('Escalation email send failed', {
          error: result.error,
          to: config.emailAddresses,
        });
      }
    }

    // Optional webhook POST
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
          url: config.webhookUrl,
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
            url: config.webhookUrl,
          });
        }
      } catch (err) {
        // `redirect: 'error'` above makes a newly-redirecting endpoint a new
        // failure mode, and undici renders it as a bare "fetch failed" — this
        // warning is the only signal there is, so it must name the cause.
        logger.warn('Escalation webhook call failed', {
          error: describeFetchFailure(err),
          url: config.webhookUrl,
        });
      }
    }
  } catch (err) {
    logger.error('notifyEscalation failed', {
      error: err instanceof Error ? err.message : String(err),
      agentId: payload.agentId,
    });
  }
}
