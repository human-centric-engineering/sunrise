/**
 * Webhook Test — Send a test ping event
 *
 * POST /api/v1/admin/orchestration/webhooks/:id/test
 *
 * Sends a test `ping` event to the configured webhook URL and returns
 * the delivery result (status code, timing, and any error).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import crypto from 'crypto';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success)
    throw new ValidationError('Invalid webhook id', { id: ['Must be a valid CUID'] });

  const webhook = await prisma.aiWebhookSubscription.findFirst({
    where: { id: parsed.data, createdBy: session.user.id },
  });
  if (!webhook) throw new NotFoundError('Webhook not found');

  const payload = JSON.stringify({
    event: 'ping',
    timestamp: new Date().toISOString(),
    data: { message: 'Test event from Sunrise webhook configuration.' },
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
