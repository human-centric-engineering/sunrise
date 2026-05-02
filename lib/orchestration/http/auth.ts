/**
 * Auth strategies for orchestration outbound HTTP.
 *
 * Secrets are referenced by env-var name; raw secret values never
 * appear in config or DB. Missing env vars fail fast — never silently
 * downgrade to an unauthenticated request.
 *
 * Supported strategies:
 *   - `none`        — no auth.
 *   - `bearer`      — `Authorization: Bearer <secret>`.
 *   - `api-key`     — `X-API-Key: <secret>`.
 *   - `query-param` — `?<name>=<secret>` appended to URL.
 *   - `basic`       — `Authorization: Basic base64(<secret>)`.
 *                     The env var holds either `user:pass` (we base64
 *                     it) or a pre-encoded `base64(user:pass)` value
 *                     (when the literal already contains a `:` it is
 *                     treated as user:pass; otherwise as pre-encoded).
 *   - `hmac`        — sign `${method}\n${path}\n${body}` with the
 *                     env-var secret and set the result as a header.
 *                     Header name and digest algorithm are
 *                     configurable for vendor variation; body template
 *                     is configurable so callers can match
 *                     vendor-specific signing schemes.
 */

import { createHmac } from 'node:crypto';
import { HttpError } from '@/lib/orchestration/http/errors';

export type HttpAuthType = 'none' | 'bearer' | 'api-key' | 'query-param' | 'basic' | 'hmac';

export interface HttpAuthConfig {
  type: HttpAuthType;
  /** Env var name holding the secret. Required for every type except `none`. */
  secret?: string;
  /** Query param name when type is 'query-param' (default: 'api_key'). */
  queryParam?: string;
  /** Header name for the HMAC signature (default: 'X-Signature'). */
  hmacHeaderName?: string;
  /** Digest algorithm for HMAC signing (default: 'sha256'). */
  hmacAlgorithm?: 'sha256' | 'sha512';
  /** Template for the signed string. Tokens: `{method}`, `{path}`, `{body}`. Default: `{method}\n{path}\n{body}`. */
  hmacBodyTemplate?: string;
}

const DEFAULT_QUERY_PARAM = 'api_key';
const DEFAULT_HMAC_HEADER = 'X-Signature';
const DEFAULT_HMAC_ALGORITHM: 'sha256' | 'sha512' = 'sha256';
const DEFAULT_HMAC_BODY_TEMPLATE = '{method}\n{path}\n{body}';

function readSecret(envVar: string): string {
  const value = process.env[envVar];
  if (!value) {
    throw new HttpError(
      'missing_auth_secret',
      `Auth secret env var "${envVar}" is not set — refusing to send unauthenticated request`,
      false
    );
  }
  return value;
}

function encodeBasic(secret: string): string {
  // If the env var already looks pre-encoded (no colon), use as-is.
  // Otherwise treat as user:pass and encode.
  if (secret.includes(':')) {
    return Buffer.from(secret, 'utf8').toString('base64');
  }
  return secret;
}

/**
 * Resolve auth into request-mutation operations: header additions and
 * an optional URL rewrite (for query-param auth). Pure — never touches
 * `process.env` for non-secret data.
 *
 * `body` is supplied so HMAC schemes can sign it. Pass an empty string
 * for body-less methods.
 */
export function applyAuth(
  auth: HttpAuthConfig | undefined,
  url: string,
  method: string,
  body: string
): { url: string; headers: Record<string, string> } {
  if (!auth || auth.type === 'none') {
    return { url, headers: {} };
  }

  if (!auth.secret) {
    // type !== 'none' but no secret env var named — treat the same as
    // missing secret. Better to fail fast than send unauth.
    throw new HttpError(
      'missing_auth_secret',
      `Auth type "${auth.type}" requires a secret env var name`,
      false
    );
  }

  const secret = readSecret(auth.secret);

  switch (auth.type) {
    case 'bearer':
      return { url, headers: { Authorization: `Bearer ${secret}` } };

    case 'api-key':
      return { url, headers: { 'X-API-Key': secret } };

    case 'basic':
      return { url, headers: { Authorization: `Basic ${encodeBasic(secret)}` } };

    case 'query-param': {
      const parsed = new URL(url);
      parsed.searchParams.set(auth.queryParam ?? DEFAULT_QUERY_PARAM, secret);
      return { url: parsed.toString(), headers: {} };
    }

    case 'hmac': {
      const headerName = auth.hmacHeaderName ?? DEFAULT_HMAC_HEADER;
      const algorithm = auth.hmacAlgorithm ?? DEFAULT_HMAC_ALGORITHM;
      const template = auth.hmacBodyTemplate ?? DEFAULT_HMAC_BODY_TEMPLATE;
      const path = new URL(url).pathname;
      const signedString = template
        .replace('{method}', method)
        .replace('{path}', path)
        .replace('{body}', body);
      const signature = createHmac(algorithm, secret).update(signedString).digest('hex');
      return { url, headers: { [headerName]: signature } };
    }
  }
}
