/**
 * Inbound trigger adapter — vendor-neutral primitive for receiving requests from
 * third-party systems (Slack, Postmark, generic-HMAC) and dispatching them as
 * workflow executions.
 *
 * Implementations live in `./adapters/`. The dispatcher route in
 * `app/api/v1/inbound/[channel]/[slug]/route.ts` resolves the adapter from the
 * registry by channel name, runs `handleHandshake` (if defined), `verify`, and
 * `normalise`, then inserts an `AiWorkflowExecution` for the background drain.
 *
 * See `.context/orchestration/inbound-triggers.md` for the full guide.
 */

import type { NextRequest } from 'next/server';

/**
 * Per-trigger context handed to `verify`. The adapter looks up channel-wide
 * secrets from env vars itself; per-trigger secret material (hashed) comes
 * from the trigger row.
 */
export interface VerifyContext {
  /** Per-trigger HMAC shared secret (plaintext), used by adapters that key on per-trigger material. */
  signingSecret: string | null;
  /** Free-form channel-specific config from `AiWorkflowTrigger.metadata`. */
  metadata: Record<string, unknown>;
  /** Raw body string — adapters that verify HMAC over the body must use this exact value. */
  rawBody: string;
}

/**
 * Result of `verify`. `valid: true` carries an optional `externalId` used for
 * replay dedup (Slack `event_id`, Postmark `MessageID`). `valid: false` carries
 * an internal reason — the route logs it but never surfaces it to the caller,
 * so attackers can't probe which check failed.
 */
export type VerifyResult =
  { valid: true; externalId?: string } | { valid: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | 'missing_signature'
  | 'bad_format'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'missing_secret_config'
  | 'unauthorized';

/**
 * Normalised payload shape — channel-agnostic envelope written into
 * `AiWorkflowExecution.inputData`. Workflows reference fields via
 * `{{ trigger.<field> }}` template substitution.
 *
 * The `payload` shape is **per-channel and versioned**: see the per-channel
 * tables in `.context/orchestration/inbound-triggers.md`, and the per-channel
 * payload interfaces exported from each adapter file:
 *   - `SlackTriggerPayload`        in `./adapters/slack.ts`
 *   - `PostmarkTriggerPayload`     in `./adapters/postmark.ts`
 *   - `GenericHmacTriggerPayload`  in `./adapters/generic-hmac.ts`
 * Adapters MUST keep the shape stable — additive changes only.
 */
/**
 * Semantic conversation channel — the medium the end user reached us on.
 * Distinct from the adapter slug (`twilio` / `whatsapp_cloud`) used in the
 * inbound URL; the same adapter slug can produce different semantic
 * channels (Twilio can carry both `sms` and `whatsapp`). See plan
 * decision 3 in the item #24 design.
 */
export type ConversationChannel = 'sms' | 'whatsapp' | 'email' | 'slack' | 'chat';

export interface NormalisedTriggerPayload {
  channel: string;
  /** Vendor identifier when present, used for replay dedup. */
  externalId?: string;
  /** Channel-specific normalised body. Documented per channel. */
  payload: Record<string, unknown>;
  /** Raw vendor-supplied event type (`message.channels`, `Inbound`, ...) for trigger filtering. */
  eventType?: string;
  /**
   * Semantic medium the end user reached us on. Set by adapters that
   * carry real end-user conversations (Twilio, WhatsApp Cloud, Postmark).
   * Slack and generic-HMAC leave this undefined. Drives find-or-create of
   * `AiConversation` keyed on `(channel, fromAddress)`.
   */
  conversationChannel?: ConversationChannel;
  /**
   * Vendor slug for the provider that delivered this message
   * (`twilio`, `meta`, future `vonage` / `messagebird` / ...). Recorded on
   * `AiConversation.provider` so outbound dispatch can find the right
   * `OutboundAdapter`. Independent of `conversationChannel` so a partner
   * who swaps providers retains conversation history.
   */
  conversationProvider?: string;
  /**
   * The canonical address the end user reached us from. Phone numbers
   * already normalised to E.164; emails as-is. Used as the second half
   * of the `(channel, fromAddress)` conversation key.
   */
  fromAddress?: string;
}

export interface InboundAdapter {
  /** Lower-case channel slug used in URLs and DB rows. Must match `AiWorkflowTrigger.channel`. */
  readonly channel: string;

  /**
   * Optional handshake handler (Slack `url_verification`). Runs before `verify`.
   * Return `null` to fall through to normal verification, or a `Response` to
   * short-circuit (e.g. echo Slack's `challenge`).
   *
   * `parsedBody` is the JSON-parsed request body (or `null` if the body was
   * absent or unparseable). Adapters that need the raw signed bytes read them
   * from the request themselves.
   */
  handleHandshake?(parsedBody: unknown): Response | null;

  /**
   * Optional GET-method handshake for providers that verify webhook URL
   * ownership before allowing POST registration (Meta WhatsApp Cloud's
   * `hub.mode=subscribe` flow). Return `null` to 405 the GET, or a
   * `Response` to echo the provider's challenge.
   *
   * Runs without consulting `AiWorkflowTrigger` — the provider validates
   * the URL itself before any trigger row exists.
   */
  handleVerificationGet?(req: NextRequest): Response | null;

  /**
   * Verify the request authenticity. MUST NOT throw — return a structured
   * failure instead. Constant-time comparisons required for all HMAC checks.
   */
  verify(req: NextRequest, ctx: VerifyContext): Promise<VerifyResult>;

  /**
   * Normalise the verified payload into the channel-agnostic shape. Called
   * only after `verify` returns `valid: true`. MUST NOT perform I/O.
   *
   * @param bodyParsed - JSON-parsed body (`null` if the body wasn't JSON,
   *   as for form-encoded vendors like Twilio).
   * @param headers - Request headers.
   * @param rawBody - Raw body string. Most adapters ignore this; Twilio
   *   (and other form-encoded vendors) parse it here because `bodyParsed`
   *   is null for them.
   */
  normalise(bodyParsed: unknown, headers: Headers, rawBody?: string): NormalisedTriggerPayload;
}
