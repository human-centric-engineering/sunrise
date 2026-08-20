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
import { describeFetchFailure } from '@/lib/errors/fetch-error';
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

  // Declared outside the `try` so `finally` can clear the timer. It used to be
  // cleared on the success line only, which `redirect: 'error'` turns from an
  // edge case into a routine one: a redirecting endpoint would leave the timer
  // armed to fire `controller.abort()` on a settled controller five seconds
  // after the response went out, once per click.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': 'ping',
      },
      body: payload,
      signal: controller.signal,
      // Refuse redirects, matching `webhooks/dispatcher.ts` on the SAME value
      // (#635). `webhook.url` is validated in the Zod refine at create/update
      // and never again, so a redirect is an unvalidated second target — and
      // `X-Webhook-Signature` is a CUSTOM header name, which the fetch spec
      // does not strip cross-origin the way it strips `Authorization`. The HMAC
      // would travel.
      //
      // The divergence also made this button lie: following a redirect reports
      // the final hop's status as the endpoint's, so an endpoint that moved
      // read as healthy here while production delivery refused it.
      redirect: 'error',
    });

    statusCode = res.status;
  } catch (err) {
    // undici renders a refused redirect, a DNS failure and a connection reset
    // all as a bare "fetch failed"; the reason lives on `cause`. This string is
    // the operator's ONLY signal — it is rendered straight into the test-result
    // panel — so without unwrapping, the redirect refusal added above would
    // report "fetch failed" and read as the endpoint being down.
    //
    // Applied to `Error` only, keeping "Unknown error" for anything else.
    // `describeFetchFailure` falls back to `String(err)`, which renders a
    // thrown object as "[object Object]" — worse in this panel than saying
    // nothing, and a change to behaviour this issue did not ask for. Two
    // existing tests caught the difference.
    error =
      err instanceof Error && err.name === 'AbortError'
        ? 'Request timed out after 5 seconds'
        : err instanceof Error
          ? describeFetchFailure(err)
          : 'Unknown error';
  } finally {
    // In `finally`, not after the `await` — `redirect: 'error'` makes the throw
    // path routine rather than exceptional, and a timer left armed there fires
    // `controller.abort()` on a settled controller five seconds after the
    // response has gone out. One live handle per click on a redirecting
    // endpoint. `webhooks/dispatcher.ts` already clears its timer this way.
    clearTimeout(timeout);
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
