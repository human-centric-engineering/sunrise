/**
 * ETag Utilities
 *
 * Weak ETag computation and conditional GET support for API endpoints.
 * Apply to frequently polled GET endpoints to avoid transferring
 * unchanged payloads.
 *
 * Usage:
 *   const etag = computeETag(data);
 *   const notModified = checkConditional(request, etag);
 *   if (notModified) return notModified;
 *   return successResponse(data, undefined, { headers: { ETag: etag } });
 */

import { createHash } from 'crypto';
import { DEFAULT_CACHE_CONTROL } from '@/lib/api/responses';

/**
 * Compute a weak ETag from any JSON-serialisable data.
 *
 * Uses SHA-256 truncated to 27 base64url chars (~162 bits) — collision
 * risk is negligible for cache-busting purposes.
 */
export function computeETag(data: unknown): string {
  return `W/"${contentHash(JSON.stringify(data))}"`;
}

/**
 * SHA-256 of `text`, truncated to 27 base64url chars (~162 bits). Shared by
 * {@link computeETag} and `recordVersion` (`lib/api/record-version.ts`).
 */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('base64url').slice(0, 27);
}

/**
 * Check the `If-None-Match` request header against the computed ETag.
 *
 * Returns a 304 Not Modified response if the client already has the
 * current version, or `null` if the response should proceed normally.
 */
export function checkConditional(request: Request, etag: string): Response | null {
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch && ifNoneMatch === etag) {
    return new Response(null, {
      status: 304,
      // Shares the constant with `successResponse` so the 200 and the 304 on the
      // same endpoint can't drift apart. A 304 without a directive would let a
      // shared cache apply its own heuristic freshness to the very entry it is
      // revalidating — the same gap the 200 path had (#487).
      headers: { ETag: etag, 'Cache-Control': DEFAULT_CACHE_CONTROL },
    });
  }
  return null;
}
