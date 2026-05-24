/**
 * Meta WhatsApp Business Cloud inbound adapter.
 *
 * Sister to TwilioAdapter for partners that go direct to Meta rather than
 * through a Business Solution Provider. Same semantic conversation
 * channel (`whatsapp`) but a different `provider` slug (`meta`) so a
 * deployment can run both side-by-side without conversation collisions.
 *
 * Verification:
 *   - POST: `X-Hub-Signature-256` header carries `sha256=<hex>`, an
 *     HMAC-SHA256 over the raw body using the app's `appSecret`. Same
 *     scheme as GitHub and Sunrise's existing generic-HMAC adapter.
 *   - GET: Meta verifies webhook URL ownership on subscription via a
 *     query-string handshake — `hub.mode=subscribe&hub.verify_token=X&
 *     hub.challenge=Y`. The adapter constant-time compares the token
 *     and echoes the challenge as plain text.
 *
 * Payload shape: deeply nested. `entry[].changes[].value.messages[]`
 * is the inbound message array. `entry[].changes[].value.statuses[]`
 * is the delivery-receipt array. v1 normalises only the first message
 * (mirrors the Twilio one-message-per-webhook contract); the trigger
 * filter on `eventType='message'` excludes status events by default.
 *
 * 24-hour conversation window: enforced on the outbound side. Inbound
 * is unaffected — we just record `lastInboundAt` on the conversation.
 *
 * Reference:
 *   - https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 *   - https://developers.facebook.com/docs/graph-api/webhooks/getting-started
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { normaliseToE164 } from '@/lib/orchestration/inbound/phone';
import type {
  InboundAdapter,
  NormalisedTriggerPayload,
  VerifyContext,
  VerifyResult,
} from '@/lib/orchestration/inbound/types';

const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

interface WhatsAppMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: { id?: string; mime_type?: string; sha256?: string; caption?: string };
  audio?: { id?: string; mime_type?: string };
  video?: { id?: string; mime_type?: string; caption?: string };
  document?: { id?: string; mime_type?: string; filename?: string };
}

interface WhatsAppChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  messages?: WhatsAppMessage[];
  statuses?: Array<{ id?: string; status?: string; recipient_id?: string }>;
}

interface WhatsAppChange {
  field?: string;
  value?: WhatsAppChangeValue;
}

interface WhatsAppEntry {
  id?: string;
  changes?: WhatsAppChange[];
}

interface WhatsAppWebhookEnvelope {
  object?: string;
  entry?: WhatsAppEntry[];
}

/**
 * Normalised WhatsApp Cloud inbound payload — stable contract, additive only.
 */
export interface WhatsAppCloudTriggerPayload {
  /** E.164 phone number of the sender. */
  from: string;
  /** Meta-side phone number identifier the message arrived on. */
  toPhoneNumberId: string;
  /** Text body. Empty string for media-only messages. */
  text: string;
  /** Meta message id (`wamid....`). */
  messageId: string;
  /** Always `'whatsapp'` for this adapter. */
  subChannel: 'whatsapp';
  /** Vendor-supplied message type (`text`, `image`, `audio`, `video`, ...). */
  messageType: string;
  /** Media attachment if the message carries one — id requires a Graph fetch. */
  attachment: {
    mediaId: string;
    mimeType: string;
    caption: string;
    filename: string;
  } | null;
}

export class WhatsAppCloudAdapter implements InboundAdapter {
  readonly channel = 'whatsapp_cloud';

  constructor(
    private readonly verifyToken: string,
    private readonly appSecret: string
  ) {}

  /**
   * Meta webhook URL ownership verification — called on subscription.
   */
  handleVerificationGet(req: NextRequest): Response | null {
    const url = new URL(req.url);
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode !== 'subscribe' || token === null || challenge === null) {
      return null;
    }

    // Constant-time compare to avoid leaking the verify token via timing.
    const providedBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(this.verifyToken);
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      return new Response('forbidden', { status: 403 });
    }

    return new Response(challenge, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async to allow future fetch-based adapters
  async verify(req: NextRequest, ctx: VerifyContext): Promise<VerifyResult> {
    const header = req.headers.get(SIGNATURE_HEADER);
    if (!header) {
      return { valid: false, reason: 'missing_signature' };
    }
    if (!this.appSecret) {
      return { valid: false, reason: 'missing_secret_config' };
    }
    if (!header.startsWith(SIGNATURE_PREFIX)) {
      return { valid: false, reason: 'bad_format' };
    }
    const providedHex = header.slice(SIGNATURE_PREFIX.length);
    if (!/^[0-9a-f]+$/i.test(providedHex)) {
      return { valid: false, reason: 'bad_format' };
    }

    const expectedHex = createHmac('sha256', this.appSecret).update(ctx.rawBody).digest('hex');
    const providedBuf = Buffer.from(providedHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false, reason: 'bad_signature' };
    }

    // externalId pulled from the message envelope in normalise.
    return { valid: true };
  }

  normalise(bodyParsed: unknown, _headers: Headers): NormalisedTriggerPayload {
    // Cast is safe because:
    //   1. HMAC verification has already passed (`verify()` ran before
    //      this method), so the bytes were not tampered with in transit.
    //   2. Every field access below uses optional chaining + defaults —
    //      a malformed shape produces `eventType: 'unknown'` and empty
    //      payload fields rather than throwing.
    //   3. Mirrors the SlackAdapter / PostmarkAdapter pattern in this
    //      directory — switching one adapter to runtime-Zod-parse the
    //      vendor envelope while the others don't would create
    //      inconsistency without a real safety win.
    const body = (bodyParsed ?? {}) as WhatsAppWebhookEnvelope;
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Status callback: `value.statuses` present, no `messages`.
    const hasMessages = (value?.messages?.length ?? 0) > 0;
    const hasStatuses = (value?.statuses?.length ?? 0) > 0;
    const eventType = hasMessages ? 'message' : hasStatuses ? 'status' : 'unknown';

    const message = value?.messages?.[0];
    const fromRaw = message?.from ?? '';
    const from = normaliseToE164(fromRaw) ?? '';
    const messageId = message?.id ?? '';

    const attachment = extractAttachment(message);

    const payload: WhatsAppCloudTriggerPayload = {
      from,
      toPhoneNumberId: value?.metadata?.phone_number_id ?? '',
      text: message?.text?.body ?? attachment?.caption ?? '',
      messageId,
      subChannel: 'whatsapp',
      messageType: message?.type ?? '',
      attachment,
    };

    return {
      channel: this.channel,
      ...(messageId ? { externalId: messageId } : {}),
      eventType,
      payload: payload as unknown as Record<string, unknown>,
      ...(from && hasMessages
        ? {
            conversationChannel: 'whatsapp',
            conversationProvider: 'meta',
            fromAddress: from,
          }
        : {}),
    };
  }
}

function extractAttachment(
  message: WhatsAppMessage | undefined
): WhatsAppCloudTriggerPayload['attachment'] {
  if (!message) return null;

  const candidates = [
    message.image && { ...message.image, filename: '' },
    message.audio && { ...message.audio, caption: '', filename: '' },
    message.video && { ...message.video, filename: '' },
    message.document && { ...message.document, caption: '' },
  ];

  for (const c of candidates) {
    if (c && typeof c.id === 'string' && c.id.length > 0) {
      return {
        mediaId: c.id,
        mimeType: (c as { mime_type?: string }).mime_type ?? '',
        caption: (c as { caption?: string }).caption ?? '',
        filename: (c as { filename?: string }).filename ?? '',
      };
    }
  }
  return null;
}
