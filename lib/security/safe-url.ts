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
 *   - **No DNS resolution — so a hostname that resolves to a private or
 *     metadata address is NOT blocked, and DNS rebinding is not defended
 *     against.** This is an accepted risk, not a mitigated one. Defending
 *     against rebinding would require resolving at validate-time AND pinning
 *     the resolved IP for the subsequent fetch, which the OpenAI/Anthropic
 *     SDKs don't expose.
 *
 *     `provider-manager.buildProviderFromConfig` re-runs this function before
 *     building a provider. That is worth having, and its own comment is
 *     accurate about why — it catches a PATCH that flipped `isLocal` without
 *     re-validating `baseUrl`, and direct DB writes that bypass the Zod layer.
 *     But it is **not** a compensating control for the gap above: it re-parses
 *     the same string and never resolves anything, so against a hostname
 *     pointing at a private address a second identical check adds nothing.
 *     (An earlier version of this comment claimed otherwise — see #534.)
 *   - **Validation is per-URL, not per-hop.** A caller that follows redirects
 *     presents the guard with only the first target; every subsequent `Location`
 *     is unchecked. Callers must either refuse redirects (`redirect: 'error'`)
 *     or re-run this check on each hop — see `fetchRevalidatingRedirects` in
 *     `lib/orchestration/knowledge/url-fetcher.ts` for the loop.
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

/**
 * IPv4-mapped (`::ffff:a9fe:a9fe`) and the deprecated IPv4-compatible
 * (`::a9fe:a9fe`) IPv6 forms, as the WHATWG parser normalizes them.
 *
 * Note the parser rewrites the readable dotted spelling into hex —
 * `new URL('http://[::ffff:169.254.169.254]/').hostname` is `[::ffff:a9fe:a9fe]` —
 * so matching only the dotted form would catch nothing that actually reaches here.
 */
const IPV4_IN_IPV6 = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const IPV4_IN_IPV6_DOTTED = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/;

/**
 * Rewrite an IPv4-in-IPv6 literal to its dotted-quad equivalent so the IPv4
 * range checks below actually see it.
 *
 * These addresses reach the same host as the bare IPv4 form — verified: a fetch
 * to `http://[::ffff:127.0.0.1]:PORT/` is served by a listener bound to
 * `127.0.0.1`. Without this, `http://[::ffff:169.254.169.254]/` matched nothing
 * in `BLOCKED_HOSTNAMES`, `parseIpv4` returned null so every range check was
 * false, and cloud metadata was reachable through a guard that reports `ok`.
 *
 * Unwrapping rather than rejecting outright is deliberate: it makes the mapped
 * form obey exactly the same policy as the plain one, so `allowLoopback` still
 * works for a local provider addressed as `::ffff:127.0.0.1`.
 */
function unwrapIpv4InIpv6(host: string): string {
  const dotted = IPV4_IN_IPV6_DOTTED.exec(host);
  if (dotted?.[1]) return dotted[1];

  const hex = IPV4_IN_IPV6.exec(host);
  if (!hex?.[1] || !hex[2]) return host;

  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export interface SafeUrlCheckOptions {
  /**
   * When true, permit loopback targets (`localhost`, `127.0.0.1`, `::1`).
   * Private RFC1918 / link-local ranges are still blocked even with this
   * flag — local model servers run on loopback, not on the LAN.
   */
  allowLoopback?: boolean;

  /**
   * When true, permit private **RFC1918** (10/8, 172.16/12, 192.168/16) and
   * **IPv6 unique-local** (`fc00::/7`) targets.
   * For a service the deployment genuinely runs on its own private network —
   * an escalation relay inside a VPC, say — where the alternative is no
   * validation at all.
   *
   * **Link-local (`169.254.0.0/16`, `fe80::/10`) is NOT relaxed**, and that is
   * the whole reason this flag is narrower than "private". A denylist of
   * metadata *literals* is not enough: `169.254.169.254` is only the
   * best-known one. AWS ECS task metadata vends IAM role credentials from
   * `169.254.170.2` and EKS Pod Identity from `169.254.170.23`, and the range
   * is reserved for exactly this class of link-local service. Nothing an
   * operator would legitimately POST an escalation to lives there, so the
   * range stays refused however the flag is set.
   *
   * **CGNAT (`100.64.0.0/10`) is not relaxed either**, for the same reason: it
   * is shared address space rather than a network the deployment owns, it is
   * the default range for overlay VPNs such as Tailscale, and Alibaba Cloud's
   * metadata service sits at `100.100.100.200`. Relaxing it would reduce
   * protection in that range to a single denylisted literal.
   *
   * Cloud-metadata hostnames and the unspecified address also stay blocked —
   * `BLOCKED_HOSTNAMES` is checked before this flag is consulted.
   *
   * Loopback is governed separately by `allowLoopback`: a VPC address is not a
   * loopback address, and conflating them would widen two things when a caller
   * asked for one. Set both if you need both.
   */
  allowPrivateNetwork?: boolean;
}

export interface SafeUrlCheckResult {
  ok: boolean;
  /** Machine-readable rejection reason. */
  reason?:
    'invalid_url' | 'disallowed_scheme' | 'blocked_host' | 'private_ip' | 'loopback_not_allowed';
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
  // Unwrap IPv4-in-IPv6 BEFORE any comparison, so a mapped literal is subject
  // to the identical denylist and range checks as its dotted-quad form (#534).
  const host = unwrapIpv4InIpv6(stripIpv6Brackets(parsed.hostname.toLowerCase()));

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

  // Link-local is checked unconditionally: `allowPrivateNetwork` relaxes RFC1918
  // and IPv6 unique-local only. 169.254.0.0/16 hosts credential-vending
  // metadata services beyond the single literal in BLOCKED_HOSTNAMES — AWS ECS
  // task metadata at 169.254.170.2, EKS Pod Identity at 169.254.170.23 — and no
  // legitimate outbound target lives in that range.
  if (isLinkLocalIp(host)) {
    return {
      ok: false,
      reason: 'private_ip',
      message: `Base URL host "${host}" resolves to a link-local address`,
    };
  }

  // The opt-in relaxes RFC1918 + IPv6 unique-local ONLY — deliberately not
  // everything `isPrivateIp` matches. That predicate also covers CGNAT
  // (100.64.0.0/10), which is shared address space rather than a network the
  // deployment owns, is the default range for overlay VPNs like Tailscale, and
  // contains Alibaba Cloud's metadata service at 100.100.100.200. Relaxing it
  // would reduce protection there to the single denylisted literal — precisely
  // the reasoning used above to keep link-local sealed.
  const relaxable = options.allowPrivateNetwork && (isRfc1918(host) || isUniqueLocalIpv6(host));
  if (!relaxable && (isPrivateIp(host) || isUniqueLocalIpv6(host))) {
    return {
      ok: false,
      reason: 'private_ip',
      message: `Base URL host "${host}" resolves to a private address`,
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

/**
 * RFC1918 only — the three ranges an organisation is actually allocated for its
 * own network. Narrower than {@link isPrivateIp}, which additionally covers
 * CGNAT shared address space; see the `allowPrivateNetwork` comment in
 * `checkSafeProviderUrl` for why the opt-in uses this one.
 */
function isRfc1918(host: string): boolean {
  const octets = parseIpv4(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
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
