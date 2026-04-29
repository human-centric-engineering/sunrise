/**
 * Notification Channel Dispatcher
 *
 * Routes approval notifications to the correct channel based on the
 * step's `notificationChannel` config. This is a thin routing layer —
 * actual delivery to external channels (Slack, email, WhatsApp) is
 * handled by webhook consumers that receive the `approval_required`
 * event with channel metadata.
 *
 * The dispatcher:
 * 1. Normalizes the channel config (string or structured object)
 * 2. Includes channel metadata in the hook/webhook event payloads
 * 3. Logs the dispatch for audit trail
 *
 * External integration pattern:
 *   step config → dispatcher → hook/webhook event → external consumer → channel API
 */

import { logger } from '@/lib/logging';
import { notificationChannelSchema } from '@/lib/validations/orchestration';

export interface NotificationChannel {
  type: string;
  target?: string;
  metadata?: Record<string, string>;
}

export interface DispatchApprovalNotificationOpts {
  executionId: string;
  workflowId: string;
  stepId: string;
  prompt?: unknown;
  /** Raw notificationChannel from step config — string or structured object. */
  notificationChannel?: unknown;
  approveUrl: string;
  rejectUrl: string;
  tokenExpiresAt: string;
}

/**
 * Normalize a raw notificationChannel value to a structured object.
 * Returns undefined if no channel is configured.
 */
export function normalizeChannel(raw: unknown): NotificationChannel | undefined {
  if (!raw) return undefined;

  const parsed = notificationChannelSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const channel = parsed.data;
  if (typeof channel === 'string') {
    return { type: channel };
  }

  return {
    type: channel.type,
    target: channel.target,
    metadata: channel.metadata,
  };
}

/**
 * Dispatch an approval notification. Normalizes the channel config and
 * logs the dispatch. Returns the normalized channel for inclusion in
 * event payloads.
 *
 * This function does NOT directly send messages to external channels.
 * External delivery is handled by webhook consumers that subscribe to
 * the `approval_required` event.
 */
export function dispatchApprovalNotification(
  opts: DispatchApprovalNotificationOpts
): NotificationChannel | undefined {
  const channel = normalizeChannel(opts.notificationChannel);

  logger.info('approval notification dispatched', {
    executionId: opts.executionId,
    workflowId: opts.workflowId,
    stepId: opts.stepId,
    channelType: channel?.type ?? 'none',
    channelTarget: channel?.target,
    hasApproveUrl: !!opts.approveUrl,
    hasRejectUrl: !!opts.rejectUrl,
  });

  return channel;
}
