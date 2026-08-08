/**
 * Stateless HMAC-signed storage access tokens.
 *
 * Grants time-limited read access to **one** storage key without a session.
 * Used by `LocalProvider.getSignedUrl()` to give private local objects the
 * same shape of read path S3 gets from presigned URLs.
 *
 * Token format: `<base64url-payload>.<base64url-signature>`
 *   payload = JSON { typ: 'storage-read', key, expiresAt }
 *   signature = HMAC-SHA256(BETTER_AUTH_SECRET, payload-bytes)
 *
 * No database storage or migration required — verification is purely
 * cryptographic, mirroring `lib/orchestration/approval-tokens.ts`.
 *
 * **`typ` is what separates this scheme from that one.** Both sign the same
 * construction with the same secret, so a MAC check alone cannot tell the two
 * protocols apart: a signature minted there verifies structurally here. What
 * kept cross-scheme replay closed before #507 was only that the two payload
 * schemas happened to be disjoint on required fields (`key` vs
 * `executionId`) — an accident of the current shapes that stops holding the
 * day either side gains an optional field, with nothing in either file to
 * flag that as security-relevant. The tag is inside the signed bytes and is
 * asserted on verify, so the separation is now structural.
 *
 * **The token is scoped to a single key, and the read route must check it
 * against the key actually requested.** That binding is the entire access
 * control model here: storage keys carry no ownership
 * (`agent-uploads/{agentId}/{uuid}` names no user), so there is nothing else
 * to authorise against. A token that verified but was not compared to the
 * requested key would be a universal read grant.
 *
 * @see app/api/v1/storage/[...key]/route.ts — the only consumer
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { isRecord } from '@/lib/utils';

/** Default token lifetime when the caller doesn't specify one. */
const DEFAULT_EXPIRY_SECONDS = 3600; // 1 hour

/**
 * Scheme tag carried in the signed payload and asserted on verify — see the
 * module header. Changing this string invalidates every outstanding token.
 */
const TOKEN_TYPE = 'storage-read';

/**
 * Upper bound on a token's life. Matches the `signedUrlTtlSeconds` ceiling in
 * the `upload_to_storage` binding schema — a longer-lived bearer URL for a
 * private file is a link that outlives the reason it was issued.
 */
export const MAX_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

const tokenPayloadSchema = z.object({
  typ: z.literal(TOKEN_TYPE),
  key: z.string().min(1),
  expiresAt: z.string().min(1),
});

type TokenPayload = z.infer<typeof tokenPayloadSchema>;

function getSecret(): string {
  return env.BETTER_AUTH_SECRET;
}

function base64UrlEncode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64url');
}

function base64UrlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function sign(payloadJson: string): string {
  return createHmac('sha256', getSecret()).update(payloadJson, 'utf8').digest('base64url');
}

/**
 * Generate a signed read token for a single storage key.
 *
 * @param key - The storage key this token grants access to, and only this key
 * @param expiresInSeconds - Lifetime, clamped to {@link MAX_EXPIRY_SECONDS}
 */
export function generateStorageAccessToken(
  key: string,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS
): { token: string; expiresAt: Date } {
  if (!key) {
    throw new Error('Storage access token requires a key');
  }

  const ttl = Math.min(Math.max(Math.floor(expiresInSeconds), 1), MAX_EXPIRY_SECONDS);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const payload: TokenPayload = { typ: TOKEN_TYPE, key, expiresAt: expiresAt.toISOString() };

  const payloadJson = JSON.stringify(payload);

  return {
    token: `${base64UrlEncode(payloadJson)}.${sign(payloadJson)}`,
    expiresAt,
  };
}

/**
 * Say which of the three schema failures happened, in the terms an operator
 * reading a 401 needs.
 *
 * A missing tag and a wrong tag are different events and must not share a
 * message. A *wrong* tag is a token from the approval scheme: authentically
 * signed, complete, and presented at the wrong door. A *missing* tag is,
 * during the upgrade window, almost always a token minted before the tag
 * existed — the scheme was right and the token merely predates the check.
 * Reporting that as "not a storage-read token" would send whoever is
 * debugging the deploy looking for a cross-scheme bug that isn't there.
 */
function describePayloadFailure(raw: unknown): string {
  if (!isRecord(raw)) return 'Incomplete storage token payload';
  if (raw.typ === undefined) return 'Storage token payload is missing its scheme tag';
  if (raw.typ !== TOKEN_TYPE) return 'Storage token payload is not a storage-read token';
  return 'Incomplete storage token payload';
}

/**
 * Verify a signed storage token. Returns the decoded payload on success, or
 * throws on tampered / expired / malformed tokens, and on an authentic token
 * belonging to another scheme signed with the same secret (see `typ` in the
 * module header).
 *
 * Verifying tells you the token is authentic — **not** that it grants access
 * to the object being requested. The caller must compare `payload.key`
 * against the requested key.
 */
export function verifyStorageAccessToken(token: string): TokenPayload {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) {
    throw new Error('Invalid storage token format');
  }

  const encodedPayload = token.slice(0, dotIndex);
  const providedSignature = token.slice(dotIndex + 1);

  let payloadJson: string;
  try {
    payloadJson = base64UrlDecode(encodedPayload);
  } catch {
    throw new Error('Invalid storage token encoding');
  }

  const expectedSignature = sign(payloadJson);

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(providedSignature, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Invalid storage token signature');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(payloadJson);
  } catch {
    throw new Error('Invalid storage token payload');
  }

  const parsed = tokenPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(describePayloadFailure(raw));
  }
  const payload = parsed.data;

  const expiresAt = new Date(payload.expiresAt);
  if (isNaN(expiresAt.getTime()) || expiresAt.getTime() < Date.now()) {
    throw new Error('Storage token has expired');
  }

  return payload;
}

/**
 * Build the signed read URL for a storage key.
 *
 * Relative by default — the route lives in this app, and a relative URL is
 * correct behind any hostname the deployment answers on. Pass `baseUrl` when
 * the URL leaves the app (an email, a webhook payload).
 */
export function buildStorageAccessUrl(
  key: string,
  expiresInSeconds?: number,
  baseUrl?: string
): { url: string; expiresAt: Date } {
  const { token, expiresAt } = generateStorageAccessToken(key, expiresInSeconds);

  // Each segment is encoded separately so the `/` separators survive.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const path = `/api/v1/storage/${encodedKey}?token=${encodeURIComponent(token)}`;

  return {
    url: baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path,
    expiresAt,
  };
}
