/**
 * Billing webhook (§139 t-1094)
 *
 * POST /api/v1/billing/webhook/[provider] — where the payment provider sends
 * its events: `/api/v1/billing/webhook/stripe` for Stripe.
 *
 * No session and no API key: the provider's signature over the raw body is
 * the only control, and it is checked before anything is parsed, read or
 * written (`handleBillingWebhook`). Rate-limited by IP by the policy table.
 *
 * Answers, and what the provider does with each:
 * - **404** — billing is off, or the URL names another provider. Stripe
 *   retries, and gives up after three days.
 * - **400** — the signature did not verify. Nothing was read.
 * - **200** — handled: applied, unchanged, a replay, an event type the
 *   platform does not act on, or one naming no organisation that exists.
 *   None of those changes if delivered again.
 * - **500** — anything else, rolled back, so the provider delivers it again.
 *
 * @see lib/billing/webhook.ts
 * @see .context/billing/billing.md#webhooks
 */

import type { NextRequest } from 'next/server';

import { errorResponse, successResponse } from '@/lib/api/responses';
import { BILLING_OFF_MESSAGE } from '@/lib/billing/config';
import { handleBillingWebhook } from '@/lib/billing/webhook';
import { logger } from '@/lib/logging';

/** A provider key as `BILLING_PROVIDER` takes one. */
const PROVIDER_PARAM = /^[a-z][a-z0-9_-]{0,39}$/;

/** Stripe's events are a few KB; this leaves room and refuses an abusive body. */
const MAX_BODY_BYTES = 512 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
): Promise<Response> {
  const { provider } = await params;
  if (!PROVIDER_PARAM.test(provider)) {
    return errorResponse(BILLING_OFF_MESSAGE, { code: 'NOT_FOUND', status: 404 });
  }
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    return errorResponse('Request body too large', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  }
  // The raw bytes, as text: a body parsed and re-serialised does not verify.
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return errorResponse('Request body too large', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  }

  try {
    const result = await handleBillingWebhook({
      providerKey: provider,
      rawBody,
      headers: request.headers,
    });
    switch (result.status) {
      case 'billing_off':
        return errorResponse(BILLING_OFF_MESSAGE, { code: 'NOT_FOUND', status: 404 });
      case 'bad_signature':
        logger.warn('billing: webhook signature did not verify', { provider });
        return errorResponse('The webhook signature did not verify', {
          code: 'INVALID_SIGNATURE',
          status: 400,
        });
      case 'recorded':
        return successResponse({ received: true, outcome: result.outcome });
      default:
        return successResponse({ received: true, outcome: result.status });
    }
  } catch (error) {
    logger.error('billing: webhook delivery failed; the provider will retry', error, { provider });
    return errorResponse('The event could not be processed', {
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  }
}
