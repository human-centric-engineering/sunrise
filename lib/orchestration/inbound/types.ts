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
  | { valid: true; externalId?: string }
  | { valid: false; reason: VerifyFailureReason };

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
 * tables in `.context/orchestration/inbound-triggers.md`. Adapters MUST keep
 * the shape stable — additive changes only.
 */
export interface NormalisedTriggerPayload {
  channel: string;
  /** Vendor identifier when present, used for replay dedup. */
  externalId?: string;
  /** Channel-specific normalised body. Documented per channel. */
  payload: Record<string, unknown>;
  /** Raw vendor-supplied event type (`message.channels`, `Inbound`, ...) for trigger filtering. */
  eventType?: string;
}

export interface InboundAdapter {
  /** Lower-case channel slug used in URLs and DB rows. Must match `AiWorkflowTrigger.channel`. */
  readonly channel: string;

  /**
   * Optional handshake handler (Slack `url_verification`). Runs before `verify`.
   * Return `null` to fall through to normal verification, or a `Response` to
   * short-circuit (e.g. echo Slack's `challenge`).
   *
   * `rawBody` is the parsed JSON body if any; adapters that need the raw string
   * read it from the request themselves.
   */
  handleHandshake?(rawBody: unknown): Response | null;

  /**
   * Verify the request authenticity. MUST NOT throw — return a structured
   * failure instead. Constant-time comparisons required for all HMAC checks.
   */
  verify(req: NextRequest, ctx: VerifyContext): Promise<VerifyResult>;

  /**
   * Normalise the verified payload into the channel-agnostic shape. Called
   * only after `verify` returns `valid: true`. MUST NOT perform I/O.
   */
  normalise(rawBody: unknown, headers: Headers): NormalisedTriggerPayload;
}
