/**
 * Stateless HMAC-signed storage access tokens.
 *
 * Grants time-limited read access to **one** storage key without a session.
 * Used by `LocalProvider.getSignedUrl()` to give private local objects the
 * same shape of read path S3 gets from presigned URLs.
 *
 * Token format: `<base64url-payload>.<base64url-signature>`
 *   payload = JSON { typ: 'storage-read', key, expiresAt, org? }
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
 * against the key actually requested.** That binding is the primary access
 * control here: storage keys name no user, so there is nothing else to
 * authorise against. A token that verified but was not compared to the
 * requested key would be a universal read grant.
 *
 * **`org` says which org the token was minted for (§109 t-736).** An
 * org-owned key (`orgs/{orgId}/…`, `lib/storage/org-keys.ts`) can only be
 * signed with a claim naming that same org, and a key that is not org-owned
 * only without one, so minting refuses a key outside the caller's org. The
 * read route then refuses a token whose claim does not match the requested
 * key's prefix. Given the key binding, that second check only bites on a
 * token minted wrongly, which is the point of it: the mint-time rule is one
 * function, and the read route is where a mistake in it would otherwise leak.
 * A token minted before the claim existed carries none, and still reads any
 * key that is not org-owned.
 *
 * @see app/api/v1/storage/[...key]/route.ts — the only consumer
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { isRecord } from '@/lib/utils';
import { isUnderOrgRoot, orgOfKey } from '@/lib/storage/org-keys';

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
  /** The org the token was minted for; absent for a key no org owns. */
  org: z.string().min(1).optional(),
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
 * The one rule tying a token's `org` claim to a key: the claim must name the
 * org the key belongs to, and be absent exactly when no org owns the key.
 * Minting and the read route both ask it, so the two checks cannot drift.
 */
export function tokenOrgMatchesKey(org: string | null | undefined, key: string): boolean {
  const keyOrg = orgOfKey(key);
  // Under the reserved root but naming no org (`orgs//x/…`, `Orgs/x/…`): no
  // claim matches, so no token can be minted for it or read it. Treating it as
  // unowned would let a claimless token reach a path the filesystem resolves
  // into some org's tree.
  if (keyOrg === null && isUnderOrgRoot(key)) return false;
  return (org ?? null) === keyOrg;
}

/** Who a token is minted for. */
export interface StorageAccessTokenOptions {
  /**
   * The org the token is minted for. Required for an org-owned key, and must
   * be that key's org; refused for a key no org owns.
   */
  orgId?: string;
}

/**
 * Generate a signed read token for a single storage key.
 *
 * @param key - The storage key this token grants access to, and only this key
 * @param expiresInSeconds - Lifetime, clamped to {@link MAX_EXPIRY_SECONDS}
 * @param options - The org the token is minted for (see the module header)
 * @throws when the key is outside `options.orgId`, or is org-owned and no org
 *   was given
 */
export function generateStorageAccessToken(
  key: string,
  expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS,
  options: StorageAccessTokenOptions = {}
): { token: string; expiresAt: Date } {
  if (!key) {
    throw new Error('Storage access token requires a key');
  }

  const { orgId } = options;
  if (!tokenOrgMatchesKey(orgId, key)) {
    throw new Error(
      orgId === undefined
        ? 'Storage access token refused: an org-owned key can only be signed for its own org'
        : 'Storage access token refused: the key is outside the org it was minted for'
    );
  }

  const ttl = Math.min(Math.max(Math.floor(expiresInSeconds), 1), MAX_EXPIRY_SECONDS);
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const payload: TokenPayload = {
    typ: TOKEN_TYPE,
    key,
    expiresAt: expiresAt.toISOString(),
    // Left off entirely, not written as undefined, so a token for a key no org
    // owns has exactly the shape it had before the claim existed.
    ...(orgId !== undefined ? { org: orgId } : {}),
  };

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
 * against the requested key, and `payload.org` against that key's org.
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
  baseUrl?: string,
  options: StorageAccessTokenOptions = {}
): { url: string; expiresAt: Date } {
  const { token, expiresAt } = generateStorageAccessToken(key, expiresInSeconds, options);

  // Each segment is encoded separately so the `/` separators survive.
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const path = `/api/v1/storage/${encodedKey}?token=${encodeURIComponent(token)}`;

  return {
    url: baseUrl ? `${baseUrl.replace(/\/$/, '')}${path}` : path,
    expiresAt,
  };
}
