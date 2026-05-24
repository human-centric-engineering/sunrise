/**
 * Meta WhatsApp Business Cloud outbound adapter.
 *
 * Endpoint:
 *   POST https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages
 * Auth: Bearer token (Meta permanent System User Access Token).
 * Body: JSON. Two shapes:
 *   - Free-form text (within the 24h conversation window):
 *     `{ messaging_product: 'whatsapp', to, type: 'text', text: { body } }`
 *   - Approved template (outside the 24h window):
 *     `{ messaging_product: 'whatsapp', to, type: 'template',
 *        template: { name, language: { code }, components? } }`
 *
 * The 24h window guard is enforced by the capability — by the time this
 * adapter is called, the capability has either confirmed the window is
 * open OR provided a `template`. If `template` is provided we send the
 * template message; otherwise text.
 *
 * `graph.facebook.com` MUST be added to `ORCHESTRATION_ALLOWED_HOSTS`.
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
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

const META_BASE_URL = 'https://graph.facebook.com/v20.0';

const whatsappCloudConfigSchema = z.object({
  /** Env var name holding the Meta System User Access Token. */
  accessTokenEnv: z.string().min(1),
  /** Meta-side phone-number-id (visible in Business Manager). */
  phoneNumberId: z.string().min(1),
  /**
   * Per-message cost in USD — Meta WhatsApp pricing is conversation-based
   * not message-based, so this is an approximation for cost-dashboard.
   */
  costPerMessageUsd: z.number().nonnegative().optional(),
});

export type WhatsAppCloudOutboundConfig = z.infer<typeof whatsappCloudConfigSchema>;

interface MetaMessageResponse {
  messaging_product?: string;
  contacts?: Array<{ input?: string; wa_id?: string }>;
  messages?: Array<{ id?: string }>;
  error?: { message?: string; code?: number };
}

export class MetaWhatsAppOutboundAdapter implements OutboundAdapter {
  readonly provider = 'meta';
  readonly supportedChannels = ['whatsapp'] as const;
  readonly configSchema = whatsappCloudConfigSchema;

  async send(
    req: OutboundMessageRequest,
    _conversation: ConversationContext,
    rawConfig: unknown
  ): Promise<OutboundSendResult> {
    if (req.channel !== 'whatsapp') {
      throw new OutboundSendError(
        'config_invalid',
        `MetaWhatsAppOutboundAdapter does not support channel "${req.channel}"`
      );
    }

    const parsed = whatsappCloudConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new OutboundSendError(
        'config_invalid',
        `Meta WhatsApp outbound config invalid: ${parsed.error.message}`
      );
    }
    const cfg = parsed.data;

    let accessToken: string;
    try {
      accessToken = resolveEnvTemplate(`\${env:${cfg.accessTokenEnv}}`);
    } catch (err) {
      throw new OutboundSendError(
        'config_invalid',
        `Meta accessToken env var unset: ${(err as Error).message}`
      );
    }
    if (!accessToken) {
      throw new OutboundSendError('config_invalid', 'Meta accessToken resolved to empty string');
    }

    // Meta wants `to` without the leading `+`.
    const toMeta = req.to.startsWith('+') ? req.to.slice(1) : req.to;

    const body = req.template
      ? {
          messaging_product: 'whatsapp',
          to: toMeta,
          type: 'template',
          template: {
            name: req.template.name,
            language: { code: req.template.languageCode },
            ...(req.template.components ? { components: req.template.components } : {}),
          },
        }
      : {
          messaging_product: 'whatsapp',
          to: toMeta,
          type: 'text',
          text: { body: req.body },
        };

    const url = `${META_BASE_URL}/${cfg.phoneNumberId}/messages`;

    const result = await executeHttpRequest({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      // Bearer auth uses an env var name — we pass the access-token env var directly.
      auth: { type: 'bearer', secret: cfg.accessTokenEnv },
      logContext: { provider: 'meta', channel: req.channel, idempotencyKey: req.idempotencyKey },
    });

    if (result.status < 200 || result.status >= 300) {
      throw mapMetaError(result.status, result.body);
    }

    const responseBody = (result.body ?? {}) as MetaMessageResponse;
    const messageId = responseBody.messages?.[0]?.id;
    if (!messageId) {
      throw new OutboundSendError(
        'vendor_rejected',
        'Meta response missing message id',
        result.status,
        responseBody
      );
    }

    return {
      transactionId: messageId,
      statusCode: result.status,
      vendorRaw: responseBody,
    };
  }
}

function mapMetaError(status: number, body: unknown): OutboundSendError {
  const message = extractMessage(body) ?? `Meta dispatch failed: HTTP ${status}`;
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
    const obj = body as { error?: { message?: unknown }; message?: unknown };
    if (typeof obj.message === 'string') return obj.message;
    if (obj.error && typeof obj.error === 'object') {
      const errMsg = (obj.error as { message?: unknown }).message;
      if (typeof errMsg === 'string') return errMsg;
    }
  }
  return undefined;
}
