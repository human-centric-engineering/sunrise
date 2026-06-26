/**
 * Anonymous Visitor ID — durable, signed, observability-only.
 *
 * Issues a stable per-browser identifier so server logs can correlate an
 * anonymous visitor's journey (page load → contact form → chat) across
 * requests, where the per-request `requestId` cannot. The value is a
 * random `nanoid` signed with an HMAC subkey derived from
 * `BETTER_AUTH_SECRET`; the signature lets the server reject tampered or
 * forged cookies so a visitor cannot poison another's log trail.
 *
 * Design constraints (why this module looks the way it does):
 *
 * - **Runtime-portable.** Signing happens in `proxy.ts` and verification
 *   in Node route handlers / server components. We use the Web Crypto API
 *   (`crypto.subtle`), which is present in BOTH the Edge and Node.js
 *   runtimes, so a fork can run its proxy in either without a crypto
 *   rewrite. We deliberately avoid `node:crypto` (Edge-incompatible).
 *
 * - **No `lib/env` import.** This module is pulled into the proxy bundle;
 *   it reads `process.env` directly (like `LOG_SANITIZE_PII` in the
 *   logger) rather than importing the heavyweight validating `lib/env`
 *   schema. The variables are still registered in `lib/env.ts` for
 *   documentation and fail-fast validation.
 *
 * - **Observability only.** The visitorId is never an authorization or
 *   identity signal — it gates nothing. It exists solely to appear in
 *   structured logs. Its privacy posture (strictly-necessary, HttpOnly,
 *   180-day TTL, not part of `eraseUser`) is documented in
 *   `.context/privacy/` and `.context/logging/`.
 *
 * @see .context/logging/visitor-tracing.md
 */

import { nanoid } from 'nanoid';

/** Cookie name carrying the signed visitor id. */
export const VISITOR_COOKIE_NAME = 'sunrise_vid';

/**
 * Request header the proxy uses to forward the *verified* visitor id to
 * server components and route handlers (mirrors the `x-nonce` mechanism).
 * The proxy is the sole writer: it sets this header from the verified
 * cookie and strips any inbound value, so a client cannot spoof it.
 */
export const VISITOR_HEADER_NAME = 'x-visitor-id';

/** Cookie lifetime: 180 days, in seconds. */
export const VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;

/**
 * HKDF `info` label — domain-separates the visitor-signing subkey from any
 * other use of `BETTER_AUTH_SECRET`. Versioned so a future scheme change
 * (e.g. `:v2`) rotates all cookies cleanly. Never reuse the raw auth
 * secret directly as a signing key.
 */
const KDF_INFO = 'sunrise:visitor-id:v1';

/** Separator between the id and its base64url signature in the cookie value. */
const SEP = '.';

const encoder = new TextEncoder();

/**
 * Whether visitor-id tracking is enabled. Default ON — this is a
 * security/observability feature (like rate limiting and security
 * headers), not opt-in analytics. A fork disables it with
 * `LOG_VISITOR_ID=false`.
 */
export function isVisitorTrackingEnabled(): boolean {
  return process.env.LOG_VISITOR_ID?.toLowerCase() !== 'false';
}

/**
 * Whether to emit a one-line structured access log per request from the
 * proxy. Default OFF — it adds a log line for every matched request, so
 * it is opt-in behind `LOG_HTTP_ACCESS=true`.
 */
export function isHttpAccessLogEnabled(): boolean {
  return process.env.LOG_HTTP_ACCESS?.toLowerCase() === 'true';
}

/** Generate a fresh opaque visitor id (URL-safe, ~126 bits). */
export function generateVisitorId(): string {
  return nanoid();
}

// Derive the HMAC signing key once per process. `BETTER_AUTH_SECRET` is
// fixed for the lifetime of the process, so we cache the derived key
// promise rather than re-running HKDF on every request.
let signingKeyPromise: Promise<CryptoKey> | null = null;

function getSigningKey(): Promise<CryptoKey> {
  if (!signingKeyPromise) {
    signingKeyPromise = deriveSigningKey();
  }
  return signingKeyPromise;
}

async function deriveSigningKey(): Promise<CryptoKey> {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    // The env schema requires BETTER_AUTH_SECRET, so this only fires in a
    // misconfigured runtime. Throw rather than silently signing with an
    // empty key (which would make all cookies trivially forgeable).
    throw new Error('BETTER_AUTH_SECRET is not set — cannot derive visitor-id signing key');
  }

  // HKDF-SHA256: import the secret as key material, then derive a
  // domain-separated 256-bit subkey using a fixed empty salt and the
  // versioned info label. The derived bytes become the HMAC signing key.
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, [
    'deriveBits',
  ]);

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encoder.encode(KDF_INFO),
    },
    keyMaterial,
    256
  );

  return crypto.subtle.importKey('raw', derivedBits, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** Encode bytes as unpadded base64url (cookie- and URL-safe). */
function toBase64Url(bytes: ArrayBuffer): string {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (const byte of view) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode unpadded base64url back to bytes. Returns null on malformed input. */
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Sign a visitor id, producing the cookie value `<id>.<base64url-sig>`.
 */
export async function signVisitorId(id: string): Promise<string> {
  const key = await getSigningKey();
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(id));
  return `${id}${SEP}${toBase64Url(signature)}`;
}

/**
 * Mint a fresh signed visitor id. Returns both the bare id (for logging)
 * and the signed cookie value (for `Set-Cookie`).
 */
export async function issueVisitorId(): Promise<{ id: string; cookieValue: string }> {
  const id = generateVisitorId();
  return { id, cookieValue: await signVisitorId(id) };
}

/**
 * Verify a signed cookie value. Returns the visitor id if the signature
 * is valid, or `null` if the value is missing, malformed, or tampered.
 * Uses `crypto.subtle.verify`, which compares the HMAC in constant time.
 */
export async function verifyVisitorId(value: string | undefined | null): Promise<string | null> {
  if (!value) return null;

  // Split on the LAST separator so an id is robust even if the nanoid
  // alphabet ever changes; the signature segment never contains SEP.
  const sepIndex = value.lastIndexOf(SEP);
  if (sepIndex <= 0 || sepIndex === value.length - 1) return null;

  const id = value.slice(0, sepIndex);
  const signature = fromBase64Url(value.slice(sepIndex + 1));
  if (!signature) return null;

  const key = await getSigningKey();
  // `fromBase64Url` returns a fresh offset-0 Uint8Array spanning exactly
  // the signature bytes, so it is a valid BufferSource as-is. verify()
  // compares the HMAC in constant time.
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(id));

  return valid ? id : null;
}

/**
 * Cookie attributes for the visitor id. `Secure` is set in production
 * only, so the cookie still works over plain HTTP in local development.
 */
export function visitorCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: VISITOR_COOKIE_MAX_AGE,
  };
}
