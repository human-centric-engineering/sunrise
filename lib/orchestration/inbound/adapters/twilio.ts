/**
 * Twilio inbound adapter (SMS + Twilio-routed WhatsApp).
 *
 * Single adapter, two semantic conversation channels — Twilio routes both
 * SMS and WhatsApp through the same webhook URL with the same HMAC scheme.
 * The `From` form field distinguishes them: SMS is `+E.164`, WhatsApp is
 * `whatsapp:+E.164`. The adapter sets `conversationChannel` to `'sms'` or
 * `'whatsapp'` on the normalised payload accordingly, and the outbound
 * adapter reads that semantic value to dispatch through the right Twilio
 * REST API path.
 *
 * Verifies the `X-Twilio-Signature` header per Twilio's documented scheme:
 *   - HMAC-SHA1 over `{publicURL}{sortedParamsConcatenated}`, base64 encoded.
 *   - `sortedParamsConcatenated` is the form parameters sorted
 *     alphabetically by key, then `key+value` pairs concatenated with no
 *     separator.
 *   - The public URL must be reconstructed exactly — see
 *     `url-reconstruct.ts` for the `TWILIO_EXTERNAL_BASE_URL` override and
 *     `X-Forwarded-*` fallback. A mismatch breaks the signature.
 *
 * Reference: https://www.twilio.com/docs/usage/security#validating-requests
 *
 * Twilio retries on 5xx for up to 4 hours, so dedup on `MessageSid` is
 * essential. The route framework's `dedupKey` UNIQUE constraint handles
 * this.
 *
 * Status callbacks (delivery receipts) arrive on the same URL with a
 * `MessageStatus` field present. They're surfaced as `eventType:
 * 'status_callback'` so trigger configs can filter them out by default;
 * inbound messages carry `eventType: 'message'`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { normaliseToE164 } from '@/lib/orchestration/inbound/phone';
import type {
  ConversationChannel,
  InboundAdapter,
  NormalisedTriggerPayload,
  VerifyContext,
  VerifyResult,
} from '@/lib/orchestration/inbound/types';
import { reconstructSignedUrl } from '@/lib/orchestration/inbound/url-reconstruct';

const SIGNATURE_HEADER = 'x-twilio-signature';
const WHATSAPP_PREFIX = 'whatsapp:';

/**
 * Normalised Twilio inbound payload — stable contract, additive only.
 * Workflow templates reference fields with `{{ trigger.<field> }}`.
 */
export interface TwilioTriggerPayload {
  /** E.164 phone number (no `whatsapp:` prefix even for WA messages). */
  from: string;
  /** E.164 phone number Twilio number we received on. */
  to: string;
  /** Message body. Empty string for MMS-only sends with no text. */
  text: string;
  /** Twilio MessageSid — the per-message identifier used for dedup. */
  messageSid: string;
  /** `'sms'` or `'whatsapp'` — the semantic medium. */
  subChannel: ConversationChannel;
  /** MMS attachments. Each `url` requires Twilio Basic-auth to fetch. */
  attachments: Array<{ url: string; contentType: string }>;
  /** Number of SMS segments Twilio split the message into (1 for short msgs). */
  numSegments: number;
  /**
   * Status-callback fields. Populated only when the webhook is a
   * status callback (MessageStatus present); empty otherwise.
   */
  status: string;
  errorCode: string;
}

export class TwilioAdapter implements InboundAdapter {
  readonly channel = 'twilio';

  constructor(private readonly authToken: string) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async to allow future fetch-based adapters
  async verify(req: NextRequest, ctx: VerifyContext): Promise<VerifyResult> {
    const signature = req.headers.get(SIGNATURE_HEADER);
    if (!signature) {
      return { valid: false, reason: 'missing_signature' };
    }

    if (!this.authToken) {
      return { valid: false, reason: 'missing_secret_config' };
    }

    // Twilio sends form-encoded bodies. Parse for the signing string;
    // the same parse is repeated in `normalise` (no I/O, cheap, simpler
    // than caching state on the adapter).
    const params = new URLSearchParams(ctx.rawBody);
    const sortedKeys = [...params.keys()].sort();
    const concatenated = sortedKeys.map((k) => `${k}${params.get(k) ?? ''}`).join('');

    const url = reconstructSignedUrl(req);
    const signingString = `${url}${concatenated}`;

    const expectedBase64 = createHmac('sha1', this.authToken)
      .update(signingString)
      .digest('base64');

    let providedBuf: Buffer;
    try {
      providedBuf = Buffer.from(signature, 'base64');
    } catch {
      return { valid: false, reason: 'bad_format' };
    }
    const expectedBuf = Buffer.from(expectedBase64, 'base64');

    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, reason: 'bad_signature' };
    }

    const messageSid = params.get('MessageSid');
    return { valid: true, ...(messageSid ? { externalId: messageSid } : {}) };
  }

  normalise(_bodyParsed: unknown, _headers: Headers, rawBody?: string): NormalisedTriggerPayload {
    // Twilio bodies are form-encoded — `bodyParsed` is null. Parse the
    // raw body here. `verify()` already ran and confirmed the body matches
    // the signature, so the parse is safe.
    const params = new URLSearchParams(rawBody ?? '');

    const fromRaw = params.get('From') ?? '';
    const toRaw = params.get('To') ?? '';
    const isWhatsApp = fromRaw.startsWith(WHATSAPP_PREFIX);
    const subChannel: ConversationChannel = isWhatsApp ? 'whatsapp' : 'sms';

    const from = normaliseToE164(fromRaw) ?? '';
    const to = normaliseToE164(toRaw) ?? '';

    const messageSid = params.get('MessageSid') ?? '';
    const messageStatus = params.get('MessageStatus') ?? '';
    const isStatusCallback = messageStatus.length > 0;
    const eventType = isStatusCallback ? 'status_callback' : 'message';

    const numMedia = Number(params.get('NumMedia') ?? '0');
    const attachments: Array<{ url: string; contentType: string }> = [];
    if (Number.isFinite(numMedia) && numMedia > 0) {
      for (let i = 0; i < numMedia; i++) {
        const url = params.get(`MediaUrl${i}`);
        const contentType = params.get(`MediaContentType${i}`) ?? '';
        if (url) attachments.push({ url, contentType });
      }
    }

    const payload: TwilioTriggerPayload = {
      from,
      to,
      text: params.get('Body') ?? '',
      messageSid,
      subChannel,
      attachments,
      numSegments: Number(params.get('NumSegments') ?? '1') || 1,
      status: messageStatus,
      errorCode: params.get('ErrorCode') ?? '',
    };

    return {
      channel: this.channel,
      ...(messageSid ? { externalId: messageSid } : {}),
      eventType,
      payload: payload as unknown as Record<string, unknown>,
      // Only set conversation-key fields for real inbound messages with
      // a recognisable sender. Status callbacks for messages WE sent
      // shouldn't create or update a conversation row for the recipient.
      ...(from && !isStatusCallback
        ? { conversationChannel: subChannel, conversationProvider: 'twilio', fromAddress: from }
        : {}),
    };
  }
}
