/**
 * Webhook Test — Send a test ping event
 *
 * POST /api/v1/admin/orchestration/webhooks/:id/test
 *
 * Sends a test event to the configured destination and returns the
 * delivery result. Channel-aware:
 *   - `webhook` channel: HMAC-signed POST of a `ping` event
 *   - `email` channel: rendered EventNotification email via Resend
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { BRAND } from '@/lib/brand';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { getResendClient, getDefaultSender, isEmailEnabled } from '@/lib/email/client';
import EventNotification from '@/emails/event-notification';
import { render } from '@react-email/render';
import crypto from 'crypto';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

  const webhook = await prisma.aiWebhookSubscription.findFirst({
    where: { id: parsed.data, createdBy: session.user.id },
  });
  if (!webhook) throw new NotFoundError('Webhook not found');

  const pingData = { message: 'Test event from Sunrise webhook configuration.' };
  const pingTimestamp = new Date().toISOString();

  // ── Email channel ────────────────────────────────────────────────────────
  if (webhook.channel === 'email') {
    if (!webhook.emailAddress) {
      return successResponse({
        success: false,
        statusCode: null,
        durationMs: 0,
        error: 'Email subscription has no destination address.',
      });
    }
    if (!isEmailEnabled()) {
      return successResponse({
        success: false,
        statusCode: null,
        durationMs: 0,
        error: 'Email sending is not configured. Set RESEND_API_KEY and EMAIL_FROM.',
      });
    }

    const start = Date.now();
    try {
      const resend = getResendClient();
      if (!resend) throw new Error('Resend client unavailable');
      const html = await render(
        EventNotification({ event: 'ping', timestamp: pingTimestamp, data: pingData })
      );
      const result = await resend.emails.send({
        from: getDefaultSender(),
        to: webhook.emailAddress,
        subject: `[${BRAND.name}] Test event`,
        html,
      });
      const durationMs = Date.now() - start;
      if (result.error) {
        log.warn('Webhook test (email) rejected', {
          webhookId: parsed.data,
          error: result.error.message,
        });
        return successResponse({
          success: false,
          statusCode: null,
          durationMs,
          error: result.error.message ?? 'Resend rejected the email',
        });
      }
      log.info('Webhook test sent (email)', {
        webhookId: parsed.data,
        durationMs,
      });
      return successResponse({ success: true, statusCode: null, durationMs, error: null });
    } catch (err) {
      const durationMs = Date.now() - start;
      return successResponse({
        success: false,
        statusCode: null,
        durationMs,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // ── Webhook channel ──────────────────────────────────────────────────────
  if (!webhook.secret) {
    return successResponse({
      success: false,
      statusCode: null,
      durationMs: 0,
      error: 'Webhook has no signing secret. Set a secret before testing.',
    });
  }
  if (!webhook.url) {
    return successResponse({
      success: false,
      statusCode: null,
      durationMs: 0,
      error: 'Webhook has no destination URL.',
    });
  }

  const payload = JSON.stringify({
    event: 'ping',
    timestamp: pingTimestamp,
    data: pingData,
  });

  const signature = crypto.createHmac('sha256', webhook.secret).update(payload).digest('hex');

  const start = Date.now();
  let statusCode: number | null = null;
  let error: string | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': 'ping',
      },
      body: payload,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    statusCode = res.status;
  } catch (err) {
    error =
      err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out after 5 seconds'
        : err instanceof Error
          ? err.message
          : 'Unknown error';
  }

  const durationMs = Date.now() - start;
  const success = statusCode !== null && statusCode >= 200 && statusCode < 300;

  log.info('Webhook test sent', {
    webhookId: parsed.data,
    url: webhook.url,
    statusCode,
    durationMs,
    success,
  });

  return successResponse({
    success,
    statusCode,
    durationMs,
    error,
  });
});
