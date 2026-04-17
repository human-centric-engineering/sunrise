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

/**
 * Compute a weak ETag from any JSON-serialisable data.
 *
 * Uses SHA-256 truncated to 27 base64url chars (~162 bits) — collision
 * risk is negligible for cache-busting purposes.
 */
export function computeETag(data: unknown): string {
  const hash = createHash('sha256').update(JSON.stringify(data)).digest('base64url').slice(0, 27);
  return `W/"${hash}"`;
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
      headers: { ETag: etag },
    });
  }
  return null;
}
