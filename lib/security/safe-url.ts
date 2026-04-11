/**
 * SSRF-safe URL validation.
 *
 * Used at every point where the application accepts an outbound HTTP
 * target from persisted data or user input — most importantly the
 * `AiProviderConfig.baseUrl` column, which an admin can set and which
 * the LLM provider factory then fetches from server-side.
 *
 * The check has two layers:
 *
 *   1. Scheme must be `http:` or `https:`. Anything else (`file:`,
 *      `gopher:`, `data:`, `javascript:`, etc.) is rejected outright.
 *   2. Host must not resolve to a loopback, link-local, private, or
 *      cloud-metadata target. Hostnames are checked against a denylist;
 *      IP literals are checked against the standard private ranges.
 *
 * `allowLoopback: true` relaxes (2) to also permit `localhost`,
 * `127.0.0.1`, `::1`, and explicit loopback hostnames. This is the
 * opt-in used by "local" provider rows that really are pointing at
 * Ollama / LM Studio / vLLM on the same box.
 *
 * Limitations — by design:
 *
 *   - No DNS resolution. Defending against DNS rebinding would require
 *     resolving at validate-time AND pinning the resolved IP for the
 *     subsequent fetch, which the OpenAI/Anthropic SDKs don't expose.
 *     We instead block all private ranges at fetch-time too (see the
 *     defense-in-depth check in `provider-manager.buildProviderFromConfig`).
 *   - No IPv4-in-IPv6 mapping parsing beyond what `URL` exposes.
 *
 * This module is platform-agnostic — no Next.js imports.
 */

/** Hostnames that are always blocked regardless of `allowLoopback`. */
const BLOCKED_HOSTNAMES = new Set<string>([
  // Cloud metadata services — the AWS / GCP / Azure / Alibaba endpoints.
  '169.254.169.254',
  'fd00:ec2::254',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  '100.100.100.200',
  // IPv4 "any" — binds to local interfaces on many stacks.
  '0.0.0.0',
  '::',
]);

/** Hostnames allowed only when `allowLoopback: true`. */
const LOOPBACK_HOSTNAMES = new Set<string>([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
]);

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

export interface SafeUrlCheckOptions {
  /**
   * When true, permit loopback targets (`localhost`, `127.0.0.1`, `::1`).
   * Private RFC1918 / link-local ranges are still blocked even with this
   * flag — local model servers run on loopback, not on the LAN.
   */
  allowLoopback?: boolean;
}

export interface SafeUrlCheckResult {
  ok: boolean;
  /** Machine-readable rejection reason. */
  reason?:
    | 'invalid_url'
    | 'disallowed_scheme'
    | 'blocked_host'
    | 'private_ip'
    | 'loopback_not_allowed';
  /** Human-readable message for Zod error rendering. */
  message?: string;
}

/**
 * Validate a URL string for use as an outbound HTTP target from the
 * server. Returns `{ ok: true }` if safe, or `{ ok: false, reason, message }`.
 *
 * Accepts only `http:` / `https:`. Blocks metadata hosts, private IP
 * ranges, and (by default) loopback targets.
 */
export function checkSafeProviderUrl(
  raw: string,
  options: SafeUrlCheckOptions = {}
): SafeUrlCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url', message: 'Base URL must be a valid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: 'disallowed_scheme',
      message: `Base URL scheme "${parsed.protocol}" is not allowed; use http: or https:`,
    };
  }

  // `URL.hostname` preserves the brackets on bracketed IPv6 literals in
  // Node's WHATWG implementation — e.g. `http://[::1]/` → `[::1]`.
  // Strip them once so hostname comparisons and IP-range checks can use
  // a single canonical form.
  const host = stripIpv6Brackets(parsed.hostname.toLowerCase());

  if (BLOCKED_HOSTNAMES.has(host)) {
    return {
      ok: false,
      reason: 'blocked_host',
      message: `Base URL host "${host}" is not allowed (cloud metadata or unspecified address)`,
    };
  }

  const isLoopback = LOOPBACK_HOSTNAMES.has(host) || isLoopbackIp(host);
  if (isLoopback) {
    if (!options.allowLoopback) {
      return {
        ok: false,
        reason: 'loopback_not_allowed',
        message:
          'Base URL must not point at loopback; set isLocal=true if this is a local provider',
      };
    }
    return { ok: true };
  }

  if (isPrivateIp(host) || isLinkLocalIp(host) || isUniqueLocalIpv6(host)) {
    return {
      ok: false,
      reason: 'private_ip',
      message: `Base URL host "${host}" resolves to a private or link-local address`,
    };
  }

  return { ok: true };
}

/**
 * Thin boolean wrapper for callers that don't need the reason —
 * e.g. defense-in-depth checks inside the provider factory.
 */
export function isSafeProviderUrl(raw: string, options: SafeUrlCheckOptions = {}): boolean {
  return checkSafeProviderUrl(raw, options).ok;
}

// ---------------------------------------------------------------------------
// IP range helpers
// ---------------------------------------------------------------------------

function parseIpv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isLoopbackIp(host: string): boolean {
  const octets = parseIpv4(host);
  if (octets) return octets[0] === 127;
  // Unbracketed IPv6 loopback.
  return host === '::1';
}

function isPrivateIp(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const [a, b] = octets;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 100.64.0.0/10 — carrier-grade NAT / shared address space
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  return false;
}

function isLinkLocalIp(host: string): boolean {
  const octets = parseIpv4(host);
  if (octets) {
    // 169.254.0.0/16
    return octets[0] === 169 && octets[1] === 254;
  }
  // IPv6 link-local: fe80::/10
  return /^fe[89ab][0-9a-f]?:/i.test(host);
}

function isUniqueLocalIpv6(host: string): boolean {
  // fc00::/7 — IPv6 unique local addresses.
  return /^f[cd][0-9a-f]{0,2}:/i.test(host);
}
