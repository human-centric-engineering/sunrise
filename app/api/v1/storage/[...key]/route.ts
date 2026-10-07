/**
 * Signed storage read route
 *
 * GET /api/v1/storage/<key...>?token=<signed>
 *
 * Serves an object the storage provider holds privately. This is what makes
 * `LocalProvider`'s private root readable over HTTP — S3 has presigned URLs
 * and doesn't need it — but the route is provider-agnostic and works with
 * any provider declaring the `download` capability.
 *
 * **Authentication is the signed token, and only the signed token.** There is
 * deliberately no session fallback. Storage keys carry no ownership —
 * `agent-uploads/{agentId}/{uuid}` names no user, and `avatars/{userId}/…`
 * only does so by convention — so `withAuth()` here would let *any* logged-in
 * user read *any* private object. That is worse than having no read path at
 * all, which is what this route replaced. The token is minted per key by
 * `getSignedUrl()` and is checked against the key actually requested.
 *
 * Rate limiting: inherited from the `/api/v1/**` catch-all in
 * `lib/security/rate-limit-policy.ts`. Anonymous callers key on IP.
 *
 * @see lib/storage/access-tokens.ts
 * @see .context/storage/overview.md
 */

import type { NextRequest } from 'next/server';
import { errorResponse } from '@/lib/api/responses';
import { logger } from '@/lib/logging';
import { getStorageClient } from '@/lib/storage/client';
import { getStorageCapabilities } from '@/lib/storage/providers/types';
import { verifyStorageAccessToken } from '@/lib/storage/access-tokens';
import { validateStorageKey } from '@/lib/storage/providers/validate-key';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
): Promise<Response> {
  const { key: segments } = await params;
  const key = segments.join('/');

  const token = request.nextUrl.searchParams.get('token');
  if (!token) {
    return errorResponse('A signed token is required to read this object', {
      code: 'TOKEN_REQUIRED',
      status: 401,
    });
  }

  let tokenKey: string;
  try {
    tokenKey = verifyStorageAccessToken(token).key;
  } catch (err) {
    // The message distinguishes expired from tampered, which is useful to a
    // legitimate caller holding a stale link and tells an attacker nothing
    // they could not learn by waiting.
    return errorResponse(err instanceof Error ? err.message : 'Invalid storage token', {
      code: 'INVALID_TOKEN',
      status: 401,
    });
  }

  // The token grants one key. Without this comparison, any valid token would
  // read any object — see the header note on why there is nothing else to
  // authorise against.
  if (tokenKey !== key) {
    logger.warn('Storage token presented for a different key', {
      requestedKey: key,
      grantedKey: tokenKey,
    });
    return errorResponse('This token does not grant access to the requested object', {
      code: 'TOKEN_KEY_MISMATCH',
      status: 403,
    });
  }

  try {
    validateStorageKey(key);
  } catch {
    // Only reachable via a token minted for a malformed key — `getSignedUrl()`
    // validates before signing.
    return errorResponse('Invalid storage key', { code: 'INVALID_KEY', status: 400 });
  }

  const storage = getStorageClient();
  if (!storage) {
    return errorResponse('Storage is not configured for this deployment', {
      code: 'STORAGE_NOT_CONFIGURED',
      status: 503,
    });
  }

  if (!getStorageCapabilities(storage).download || typeof storage.download !== 'function') {
    return errorResponse(
      `The configured storage provider (${storage.name}) cannot read objects back`,
      { code: 'DOWNLOAD_NOT_SUPPORTED', status: 501 }
    );
  }

  let object;
  try {
    object = await storage.download(key);
  } catch (err) {
    logger.info('Storage read failed', {
      key,
      provider: storage.name,
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Object not found', { code: 'NOT_FOUND', status: 404 });
  }

  const filename = key.split('/').pop() || 'download';

  return new Response(new Uint8Array(object.body), {
    status: 200,
    headers: {
      // Always `octet-stream` + `attachment`, even when the provider knows the
      // real type. These are user-supplied bytes served from the app's own
      // origin: rendering an uploaded `.html` or `.svg` inline would be stored
      // XSS with access to session cookies. A caller that needs to display the
      // object should fetch it and build its own object URL.
      'Content-Type': 'application/octet-stream',
      // Measured from the body being sent, not the provider's `size` field.
      // A provider that reported one and returned the other would produce a
      // response the client either truncates or waits forever to finish.
      'Content-Length': String(object.body.length),
      'Content-Disposition': `attachment; filename="${toHeaderFilename(filename)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // The URL is a bearer credential with a short life. Shared caches must
      // not keep the bytes past it.
      'Cache-Control': 'private, no-store, max-age=0',
    },
  });
}

/**
 * Reduce a key's final segment to something safe inside a quoted
 * `filename="…"` header parameter.
 *
 * Deliberately **not** `sanitizeFilename()` from `@/lib/security/sanitize`:
 * that one is built for filesystem safety (traversal sequences, path
 * separators, control characters) and preserves unicode and punctuation —
 * including the double-quote, which is the one character that matters here,
 * because it terminates the parameter and lets a crafted key append another.
 * This is an allowlist for a header context, not a denylist for a path.
 */
function toHeaderFilename(name: string): string {
  // Every rejected character maps to `_`, so a non-empty name always yields a
  // non-empty result — the caller has already substituted 'download' for an
  // empty final segment.
  return name.replace(/[^\w.-]/g, '_').slice(0, 100);
}
