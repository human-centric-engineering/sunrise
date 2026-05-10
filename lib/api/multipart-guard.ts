/**
 * Multipart body-size guard.
 *
 * Routes that accept multipart uploads (`request.formData()`) materialise
 * the entire body in memory before any post-parse size check can run. On
 * self-hosted Node a malicious caller can use that to OOM the process.
 * This module exposes a small pre-parse guard that consults the
 * `Content-Length` header and short-circuits with a 413 response before
 * the multipart parser allocates anything.
 *
 * Modelled after the existing MCP transport guard
 * (`app/api/v1/mcp/route.ts:76-85`). Header semantics are deliberately
 * permissive so that legitimate clients are never rejected by a header
 * glitch:
 *
 *   - Missing `content-length` → pass through. Some proxies strip it on
 *     chunked transfer encoding; the post-parse check is the backstop.
 *   - Non-numeric `content-length` → pass through. Don't reject good
 *     clients on a malformed header.
 *   - Numeric and over `maxBytes` → reject with the supplied error
 *     code + message in a 413 envelope.
 *
 * Each route supplies its own cap and error-code pair because the
 * client-facing copy and code are domain-specific (audio uploads use
 * `AUDIO_TOO_LARGE`, knowledge document uploads use `FILE_TOO_LARGE`,
 * etc.). The helper itself stays generic.
 */

import { errorResponse } from '@/lib/api/responses';

export interface ContentLengthCapOptions {
  /** Maximum body size accepted before parsing, in bytes. */
  maxBytes: number;
  /** Error envelope `code` to surface on rejection. */
  errorCode: string;
  /** Human-readable error message. */
  errorMessage: string;
  /** Optional structured details to include in the response. */
  details?: Record<string, unknown>;
}

/**
 * Reject the request with a 413 if its `Content-Length` header exceeds
 * `options.maxBytes`. Returns `null` when the request passes (or when
 * no usable header is present), letting the caller proceed to parse
 * the body.
 */
export function enforceContentLengthCap(
  request: Request,
  options: ContentLengthCapOptions
): Response | null {
  const header = request.headers.get('content-length');
  if (!header) return null;
  const length = Number.parseInt(header, 10);
  if (!Number.isFinite(length)) return null;
  if (length <= options.maxBytes) return null;
  return errorResponse(options.errorMessage, {
    code: options.errorCode,
    status: 413,
    ...(options.details ? { details: options.details } : {}),
  });
}
