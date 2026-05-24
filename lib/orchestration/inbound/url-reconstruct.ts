/**
 * Signed-URL reconstruction for HMAC-verified inbound webhooks.
 *
 * Twilio (and some other providers) sign the **exact URL** the request
 * was sent to, including scheme, host, port, path, and query string.
 * The signature breaks if the URL we reconstruct differs from the URL
 * the provider hit.
 *
 * In production, Sunrise typically sits behind a proxy (Vercel, Cloudflare,
 * a load balancer) that terminates TLS and forwards the request over
 * plain HTTP to the Next.js process. `req.url` then reflects the internal
 * `http://` URL, not the public `https://` URL Twilio signed. Two
 * mechanisms exist to recover the signed URL:
 *
 *   1. `TWILIO_EXTERNAL_BASE_URL` env var — explicit override. Highest
 *      precedence. Use when you know the public origin (e.g. behind
 *      Cloudflare with custom certificate handling).
 *   2. `X-Forwarded-Proto` + `X-Forwarded-Host` headers — set by most
 *      reverse proxies including Vercel and standard nginx setups.
 *      Trusted by default; set `TWILIO_TRUST_FORWARDED_HEADERS=false` to
 *      ignore them and fall through to `req.url`.
 *   3. `req.url` — last resort, only correct when there is no proxy.
 *
 * The helper preserves the path and query string from `req.url` and only
 * rewrites the origin (scheme + host + port).
 */

import type { NextRequest } from 'next/server';

export interface ReconstructOptions {
  /**
   * Force-disable the X-Forwarded-* fallback. Useful in tests, or in
   * environments where forwarded headers are not trustworthy and only
   * the explicit env override should be honoured.
   */
  trustForwardedHeaders?: boolean;
}

/**
 * Reconstruct the public URL the provider signed against.
 */
export function reconstructSignedUrl(req: NextRequest, opts: ReconstructOptions = {}): string {
  const url = new URL(req.url);

  const override = process.env.TWILIO_EXTERNAL_BASE_URL?.trim();
  if (override) {
    const base = new URL(override);
    url.protocol = base.protocol;
    // Reset port BEFORE setting host — setting `host` alone preserves
    // the original port (a quirk of the WHATWG URL spec). The
    // `base.host` getter returns "hostname:port" when a non-default port
    // is set and just "hostname" otherwise.
    url.port = '';
    url.host = base.host;
    return url.toString();
  }

  const trustForwarded =
    opts.trustForwardedHeaders ?? process.env.TWILIO_TRUST_FORWARDED_HEADERS !== 'false';

  if (trustForwarded) {
    const fwdProto = req.headers.get('x-forwarded-proto');
    const fwdHost = req.headers.get('x-forwarded-host');
    if (fwdProto && fwdHost) {
      url.protocol = `${fwdProto}:`;
      url.port = ''; // same quirk — see comment above
      url.host = fwdHost;
      return url.toString();
    }
  }

  return req.url;
}
