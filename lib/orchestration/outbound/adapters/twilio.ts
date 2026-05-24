/**
 * Twilio outbound adapter — dispatches SMS + WhatsApp via Twilio's REST
 * API. Sister to the Twilio inbound adapter; both run when
 * `TWILIO_AUTH_TOKEN` is set in env (paired bootstrap).
 *
 * Endpoint:
 *   POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json
 * Auth: HTTP Basic (Account SID as username, Auth Token as password).
 * Body: form-encoded `From`, `To`, `Body`.
 *
 * For WhatsApp messages, both `From` and `To` are prefixed `whatsapp:`
 * — Twilio routes the message accordingly. The capability passes the
 * E.164 `to` field; this adapter adds the prefix when `channel ===
 * 'whatsapp'`.
 *
 * `api.twilio.com` MUST be added to `ORCHESTRATION_ALLOWED_HOSTS`.
 * Documented in the recipe; `executeHttpRequest` fails clean with
 * `HttpError('host_not_allowed')` if missing.
 *
 * Reference: https://www.twilio.com/docs/sms/api/message-resource
 */

import { z } from 'zod';
import { executeHttpRequest } from '@/lib/orchestration/http';
import {
  OutboundSendError,
  type ConversationContext,
  type OutboundAdapter,
  type OutboundMessageRequest,
  type OutboundSendResult,
} from '@/lib/orchestration/outbound/types';
import { resolveEnvTemplate } from '@/lib/orchestration/env-template';

const TWILIO_BASE_URL = 'https://api.twilio.com/2010-04-01/Accounts';
const WHATSAPP_PREFIX = 'whatsapp:';

const twilioConfigSchema = z.object({
  /** Env var name holding the Twilio Account SID. */
  accountSidEnv: z.string().min(1),
  /** Env var name holding the Twilio Auth Token. */
  authTokenEnv: z.string().min(1),
  /** Default `From` for SMS dispatches. Twilio number in E.164. */
  fromNumberSms: z.string().optional(),
  /** Default `From` for WhatsApp dispatches. Twilio WA number in E.164. */
  fromNumberWhatsapp: z.string().optional(),
  /**
   * Per-message cost in USD — recorded on `AiCostLog` by the capability.
   * Twilio prices vary by destination country and modality; operators
   * should set this to an average for cost-dashboard purposes.
   */
  costPerMessageUsd: z.number().nonnegative().optional(),
});

export type TwilioOutboundConfig = z.infer<typeof twilioConfigSchema>;

interface TwilioMessageResponse {
  sid?: string;
  status?: string;
  error_code?: number | null;
  error_message?: string | null;
}

export class TwilioOutboundAdapter implements OutboundAdapter {
  readonly provider = 'twilio';
  readonly supportedChannels = ['sms', 'whatsapp'] as const;
  readonly configSchema = twilioConfigSchema;

  async send(
    req: OutboundMessageRequest,
    _conversation: ConversationContext,
    rawConfig: unknown
  ): Promise<OutboundSendResult> {
    const parsed = twilioConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new OutboundSendError(
        'config_invalid',
        `Twilio outbound config invalid: ${parsed.error.message}`
      );
    }
    const cfg = parsed.data;

    let accountSid: string;
    let authToken: string;
    try {
      accountSid = resolveEnvTemplate(`\${env:${cfg.accountSidEnv}}`);
      authToken = resolveEnvTemplate(`\${env:${cfg.authTokenEnv}}`);
    } catch (err) {
      throw new OutboundSendError(
        'config_invalid',
        `Twilio credential env var unset: ${(err as Error).message}`
      );
    }
    if (!accountSid || !authToken) {
      throw new OutboundSendError(
        'config_invalid',
        'Twilio accountSid or authToken resolved to empty string'
      );
    }

    const isWhatsApp = req.channel === 'whatsapp';
    const fromNumber = isWhatsApp ? cfg.fromNumberWhatsapp : cfg.fromNumberSms;
    if (!fromNumber) {
      throw new OutboundSendError(
        'config_invalid',
        `Twilio config missing ${isWhatsApp ? 'fromNumberWhatsapp' : 'fromNumberSms'}`
      );
    }

    const url = `${TWILIO_BASE_URL}/${accountSid}/Messages.json`;
    const formBody = new URLSearchParams();
    formBody.set('From', isWhatsApp ? `${WHATSAPP_PREFIX}${fromNumber}` : fromNumber);
    formBody.set('To', isWhatsApp ? `${WHATSAPP_PREFIX}${req.to}` : req.to);
    formBody.set('Body', req.body);

    // Twilio's REST API uses HTTP Basic with SID:token. The Sunrise HTTP
    // fetcher's `basic` auth mode reads a single env var; we have two
    // (`accountSidEnv` + `authTokenEnv`). Build the Authorization header
    // manually instead of contorting the schema — env-var safety still
    // honoured by `resolveEnvTemplate` above.
    const basicHeader = `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;

    const result = await executeHttpRequest({
      url,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicHeader,
      },
      body: formBody.toString(),
      auth: { type: 'none' },
      logContext: { provider: 'twilio', channel: req.channel, idempotencyKey: req.idempotencyKey },
    });

    if (result.status < 200 || result.status >= 300) {
      throw mapTwilioError(result.status, result.body);
    }

    // Cast is safe because: 2xx Twilio responses are documented to carry
    // `sid` on success; the explicit `!body.sid` check below treats any
    // other shape as a `vendor_rejected` outcome. We deliberately don't
    // Zod-parse — see the matching comment in the Meta outbound adapter.
    const body = (result.body ?? {}) as TwilioMessageResponse;
    if (!body.sid) {
      throw new OutboundSendError(
        'vendor_rejected',
        'Twilio response missing message SID',
        result.status,
        body
      );
    }

    return {
      transactionId: body.sid,
      statusCode: result.status,
      vendorRaw: body,
    };
  }
}

function mapTwilioError(status: number, body: unknown): OutboundSendError {
  const message = extractMessage(body) ?? `Twilio dispatch failed: HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new OutboundSendError('vendor_unauthorized', message, status, body);
  }
  if (status === 429) {
    return new OutboundSendError('vendor_rate_limited', message, status, body);
  }
  if (status >= 500) {
    return new OutboundSendError('vendor_unavailable', message, status, body);
  }
  return new OutboundSendError('vendor_rejected', message, status, body);
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const obj = body as { message?: unknown; error_message?: unknown };
    if (typeof obj.message === 'string') return obj.message;
    if (typeof obj.error_message === 'string') return obj.error_message;
  }
  return undefined;
}
