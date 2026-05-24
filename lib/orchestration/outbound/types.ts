/**
 * Outbound channel adapter — vendor-neutral primitive for dispatching
 * messages back on the channel a conversation came in on.
 *
 * Sister to `lib/orchestration/inbound/types.ts`. Each provider ships
 * paired inbound + outbound adapters so adding a new SMS / WhatsApp
 * vendor (Vonage, MessageBird, Plivo, ...) is two adapter files plus a
 * bootstrap env-var conditional — no capability changes required.
 *
 * The `send_message_to_channel` capability is the only caller — it
 * loads `AiConversation.(channel, provider, fromAddress)`, looks up the
 * registered `OutboundAdapter` for the conversation's provider, and
 * delegates. The capability owns guards (STOP-flag, WhatsApp 24h window,
 * length cap, throttle, idempotency, cost log, PII redaction); the
 * adapter owns vendor API translation only.
 *
 * See `.context/orchestration/outbound-adapters.md` for the full guide
 * including the worked Vonage extension example.
 */

import type { z } from 'zod';
import type { ConversationChannel } from '@/lib/orchestration/inbound/types';

/**
 * Request shape passed from the capability to an adapter. Adapter
 * translates this into vendor-specific HTTP calls.
 */
export interface OutboundMessageRequest {
  /** Recipient address (E.164 phone for SMS/WhatsApp, email for email). */
  to: string;
  /** Semantic medium. Adapter MUST refuse if not in `supportedChannels`. */
  channel: ConversationChannel;
  /** Message body. Plain text. */
  body: string;
  /**
   * WhatsApp template for messages outside the 24-hour conversation
   * window. Optional; provided by the capability only when required.
   */
  template?: {
    name: string;
    languageCode: string;
    components?: Array<Record<string, unknown>>;
  };
  /**
   * Deterministic idempotency key — adapters that pass this through to
   * vendors that support `Idempotency-Key` (Stripe-style) should do so.
   * Twilio doesn't natively support an idempotency header; the
   * capability-side `AiOutboundMessage.dedupKey` UNIQUE constraint is
   * the primary safety net.
   */
  idempotencyKey: string;
}

/**
 * Just enough conversation context for an adapter to dispatch. Includes
 * provider for self-checking and the original inbound-touchpoint
 * timestamps the adapter may need for retry/throttle decisions.
 */
export interface ConversationContext {
  id: string;
  channel: ConversationChannel;
  provider: string;
  fromAddress: string;
  lastInboundAt: Date | null;
}

/**
 * Result the adapter returns. The capability logs cost (it knows the
 * configured per-message rate); adapter is stateless and just reports
 * the vendor transactionId + status.
 */
export interface OutboundSendResult {
  /** Vendor-side transaction / message identifier. */
  transactionId: string;
  /** HTTP status code from the vendor dispatch. */
  statusCode: number;
  /** Raw vendor response — for logging / debugging only. */
  vendorRaw?: unknown;
}

/**
 * Adapter contract.
 */
export interface OutboundAdapter {
  /** Vendor slug, matches `AiConversation.provider`. */
  readonly provider: string;
  /** Channels this adapter can dispatch on. */
  readonly supportedChannels: readonly ConversationChannel[];
  /**
   * Zod schema for the adapter's portion of the capability's
   * `customConfig.providers[provider]` block. The capability validates
   * before calling `send`, so `config` arrives typed.
   */
  readonly configSchema: z.ZodTypeAny;
  /**
   * Dispatch the message via the vendor's API. MUST throw `OutboundSendError`
   * (or extend it) on failure — never return `{ status: 4xx }`. The
   * capability translates thrown errors into typed `error()` results.
   */
  send(
    req: OutboundMessageRequest,
    conversation: ConversationContext,
    config: unknown
  ): Promise<OutboundSendResult>;
}

/**
 * Typed error for vendor dispatch failures. Capability maps `code` to
 * a stable error code in its `error()` result so workflows can branch.
 */
export class OutboundSendError extends Error {
  constructor(
    public readonly code: OutboundErrorCode,
    message: string,
    public readonly statusCode?: number,
    public readonly vendorRaw?: unknown
  ) {
    super(message);
    this.name = 'OutboundSendError';
  }
}

export type OutboundErrorCode =
  | 'config_invalid'
  | 'vendor_rejected'
  | 'vendor_unauthorized'
  | 'vendor_rate_limited'
  | 'vendor_unavailable'
  | 'allowlist_blocked'
  | 'unknown';
