/**
 * Generic HMAC inbound adapter.
 *
 * Reuses the outbound webhook signature scheme (`X-Sunrise-Signature: sha256=…`
 * + `X-Sunrise-Timestamp`) so the same `verifyHookSignature` primitive validates
 * both directions. Each trigger row carries its own `signingSecret`; rotation
 * is "create new trigger, retire old".
 *
 * Body shape is opaque — this adapter pass-throughs the parsed JSON body as
 * `payload.body`. Workflow templates reference fields with `{{ trigger.body.<...> }}`.
 *
 * Replay protection: senders that want dedup put `eventId` (and optionally
 * `eventType`) at the top level of the JSON body. Because the body is included
 * in the HMAC, the eventId is bound to the signature — an attacker who captures
 * a valid signed request cannot mutate the eventId to bypass dedup. Senders
 * that omit `eventId` get no event-level dedup; the only protection then is
 * the 5-minute timestamp window enforced by `verifyHookSignature`.
 *
 * Earlier versions of this adapter read `eventId` from an unsigned
 * `X-Sunrise-Event-Id` header — that header is intentionally NOT supported,
 * because reading dedup material from an unsigned header would let any captured
 * request be replayed by mutating the header on each call.
 */

import type { NextRequest } from 'next/server';
import { verifyHookSignature } from '@/lib/orchestration/hooks/signing';
import type {
  InboundAdapter,
  NormalisedTriggerPayload,
  VerifyContext,
  VerifyResult,
} from '@/lib/orchestration/inbound/types';

const SIGNATURE_HEADER = 'x-sunrise-signature';
const TIMESTAMP_HEADER = 'x-sunrise-timestamp';

interface GenericHmacBody {
  eventId?: unknown;
  eventType?: unknown;
}

/** Read a string field from the parsed body, or undefined if absent / wrong type. */
function readBodyString(body: unknown, key: keyof GenericHmacBody): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as GenericHmacBody)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export class GenericHmacAdapter implements InboundAdapter {
  readonly channel = 'hmac';

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async to allow future fetch-based adapters
  async verify(req: NextRequest, ctx: VerifyContext): Promise<VerifyResult> {
    if (!ctx.signingSecret) {
      // Trigger row was created without a secret. Fail closed — the route
      // logs `missing_secret_config`; the client sees a generic 401.
      return { valid: false, reason: 'missing_secret_config' };
    }

    const signature = req.headers.get(SIGNATURE_HEADER);
    const timestamp = req.headers.get(TIMESTAMP_HEADER);
    if (!signature || !timestamp) {
      return { valid: false, reason: 'missing_signature' };
    }

    const result = verifyHookSignature(ctx.signingSecret, ctx.rawBody, timestamp, signature);
    if (!result.valid) {
      return { valid: false, reason: result.reason };
    }

    return { valid: true };
  }

  normalise(rawBody: unknown, _headers: Headers): NormalisedTriggerPayload {
    // eventId / eventType come from the JSON body, not headers — body is signed.
    const externalId = readBodyString(rawBody, 'eventId');
    const eventType = readBodyString(rawBody, 'eventType');

    return {
      channel: this.channel,
      ...(externalId ? { externalId } : {}),
      ...(eventType ? { eventType } : {}),
      payload: { body: rawBody },
    };
  }
}
