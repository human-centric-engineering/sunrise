/**
 * Escalation Notifier
 *
 * Reads escalation config from the orchestration settings singleton and
 * sends email notifications (and optionally a webhook POST) when a
 * conversation is escalated to a human.
 *
 * Called fire-and-forget from `EscalateToHumanCapability.execute()`.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { sendEmail } from '@/lib/email/send';
import { EscalationNotification } from '@/emails/escalation-notification';
import { escalationConfigSchema } from '@/lib/validations/orchestration';
import { env } from '@/lib/env';
import { isRecord } from '@/lib/utils';
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
 * Parse the stored `escalationConfig` JSON from the settings singleton.
 * Returns `null` if the value is absent, null, or fails validation.
 */
function parseEscalationConfig(raw: Prisma.JsonValue | null | undefined): EscalationConfig | null {
  const parsed = escalationConfigSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  // `webhookUrl` gained an SSRF refine in #553, so a config stored before that
  // — or written straight to the DB — can now fail on the webhook alone.
  // Returning null here would silently stop the EMAIL escalations too, which is
  // the wrong failure for a high-priority signal and would happen on upgrade
  // without anyone touching the config. Drop just the webhook and say so.
  if (isRecord(raw) && typeof raw.webhookUrl === 'string') {
    const withoutWebhook = escalationConfigSchema.safeParse({ ...raw, webhookUrl: undefined });
    if (withoutWebhook.success) {
      logger.warn('Escalation webhookUrl rejected; sending email notifications only', {
        webhookUrl: raw.webhookUrl,
        reason: 'URL is not allowed (private or internal address)',
      });
      return withoutWebhook.data;
    }
  }

  return null;
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
        logger.warn('Escalation webhook call failed', {
          error: err instanceof Error ? err.message : String(err),
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
