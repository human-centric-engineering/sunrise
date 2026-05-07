/**
 * Slack inbound adapter (single-workspace).
 *
 * Verifies Slack's signing-secret HMAC over `v0:{timestamp}:{rawBody}` per
 * https://api.slack.com/authentication/verifying-requests-from-slack. ≤5min
 * timestamp window blocks replays. Constant-time compare via `timingSafeEqual`.
 *
 * `handleHandshake` short-circuits Slack's URL-verification probe (sent on app
 * install / events-URL change) by echoing the `challenge` as plain text.
 *
 * Multi-workspace OAuth is **explicitly out of scope** for v1 — see
 * `.context/orchestration/inbound-triggers.md` for the design rationale and
 * what a future multi-workspace adapter would change.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import type {
  InboundAdapter,
  NormalisedTriggerPayload,
  VerifyContext,
  VerifyResult,
} from '@/lib/orchestration/inbound/types';

const SIGNATURE_HEADER = 'x-slack-signature';
const TIMESTAMP_HEADER = 'x-slack-request-timestamp';
const SIGNATURE_PREFIX = 'v0=';
const MAX_AGE_SEC = 60 * 5;

interface SlackEventInner {
  type?: string;
  user?: string;
  bot_id?: string;
  channel?: string;
  channel_type?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
}

interface SlackEventEnvelope {
  type?: string; // 'event_callback' | 'url_verification'
  challenge?: string;
  team_id?: string;
  api_app_id?: string;
  event?: SlackEventInner;
  event_id?: string;
  event_time?: number;
}

/**
 * Shape of the Slack adapter's normalised `payload`. Workflow templates reference
 * fields with `{{ trigger.<field> }}`. Empty-string defaults populate every field
 * so templates can rely on shape stability across messages.
 *
 * Stable contract — additive changes only. See `inbound-triggers.md` for the
 * field-by-field source mapping.
 */
export interface SlackTriggerPayload {
  teamId: string;
  appId: string;
  eventTime: number;
  type: string;
  user: string;
  botId: string;
  channel: string;
  channelType: string;
  text: string;
  ts: string;
  threadTs: string;
}

export class SlackAdapter implements InboundAdapter {
  readonly channel = 'slack';

  constructor(private readonly signingSecret: string) {}

  handleHandshake(parsedBody: unknown): Response | null {
    const body = (parsedBody ?? {}) as SlackEventEnvelope;
    if (body.type !== 'url_verification') return null;

    const challenge = typeof body.challenge === 'string' ? body.challenge : '';
    return new Response(challenge, {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- interface is async to allow future fetch-based adapters
  async verify(req: NextRequest, ctx: VerifyContext): Promise<VerifyResult> {
    const signature = req.headers.get(SIGNATURE_HEADER);
    const timestamp = req.headers.get(TIMESTAMP_HEADER);
    if (!signature || !timestamp) {
      return { valid: false, reason: 'missing_signature' };
    }

    if (!signature.startsWith(SIGNATURE_PREFIX)) {
      return { valid: false, reason: 'bad_format' };
    }
    const providedHex = signature.slice(SIGNATURE_PREFIX.length);
    if (!/^[0-9a-f]+$/i.test(providedHex)) {
      return { valid: false, reason: 'bad_format' };
    }

    const timestampSec = Number(timestamp);
    if (!Number.isFinite(timestampSec) || !Number.isInteger(timestampSec)) {
      return { valid: false, reason: 'bad_format' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - timestampSec) > MAX_AGE_SEC) {
      return { valid: false, reason: 'stale_timestamp' };
    }

    const expectedHex = createHmac('sha256', this.signingSecret)
      .update(`v0:${timestampSec}:${ctx.rawBody}`)
      .digest('hex');
    const provided = Buffer.from(providedHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return { valid: false, reason: 'bad_signature' };
    }

    // event_id read in normalise; route uses normalised externalId for dedup.
    return { valid: true };
  }

  normalise(rawBody: unknown, _headers: Headers): NormalisedTriggerPayload {
    const body = (rawBody ?? {}) as SlackEventEnvelope;
    const event = body.event ?? {};

    const externalId = body.event_id;
    const eventType = event.type;

    return {
      channel: this.channel,
      ...(externalId ? { externalId } : {}),
      ...(eventType ? { eventType } : {}),
      payload: {
        teamId: body.team_id ?? '',
        appId: body.api_app_id ?? '',
        eventTime: body.event_time ?? 0,
        type: event.type ?? '',
        user: event.user ?? '',
        botId: event.bot_id ?? '',
        channel: event.channel ?? '',
        channelType: event.channel_type ?? '',
        text: event.text ?? '',
        ts: event.ts ?? '',
        threadTs: event.thread_ts ?? '',
      },
    };
  }
}
