/**
 * Security Headers Utilities
 *
 * Centralized security header management with environment-specific CSP.
 * Follows OWASP security header recommendations.
 *
 * Features:
 * - Environment-aware Content Security Policy
 * - Centralized header management
 * - Production-ready defaults
 * - Development-friendly configuration (allows HMR/Fast Refresh)
 *
 * @example
 * ```typescript
 * import { setSecurityHeaders } from '@/lib/security/headers';
 *
 * // In middleware
 * const response = NextResponse.next();
 * setSecurityHeaders(response);
 * ```
 */

import { NextResponse } from 'next/server';
import { appConnectSrc, appFrameSrc, appMediaSrc, appScriptSrc } from '@/lib/app/csp';
import { logger } from '@/lib/logging';

/**
 * Content Security Policy directive configuration
 */
export interface CSPConfig {
  'default-src': string[];
  'script-src': string[];
  'style-src': string[];
  'img-src': string[];
  'media-src': string[];
  'font-src': string[];
  'connect-src': string[];
  'worker-src': string[];
  'frame-src': string[];
  'frame-ancestors': string[];
  'form-action': string[];
  'base-uri': string[];
  'object-src': string[];
  'upgrade-insecure-requests'?: boolean;
  'report-uri'?: string;
}

/**
 * Development CSP - permissive for HMR and Fast Refresh
 *
 * Allows:
 * - 'unsafe-eval' for Next.js HMR
 * - 'unsafe-inline' for Next.js inline scripts/styles
 * - webpack://* for source maps
 * - ws://localhost:* for WebSocket HMR connection
 */
const DEVELOPMENT_CSP: CSPConfig = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-eval'", "'unsafe-inline'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'https:', 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'webpack://*', 'ws://localhost:*', 'wss://localhost:*'],
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
};

/**
 * Production CSP - strict for maximum security
 *
 * Blocks:
 * - Inline scripts (XSS prevention)
 * - eval() and related functions
 * - Framing by other sites (clickjacking prevention)
 *
 * Allows:
 * - 'unsafe-inline' for style-src (required for Tailwind CSS)
 * - External images over HTTPS
 */
const PRODUCTION_CSP: CSPConfig = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"], // Required for Tailwind
  'img-src': ["'self'", 'data:', 'https:', 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'font-src': ["'self'", 'data:'],
  // External fetch/XHR must be proxied through server-side API routes — client-side
  // calls to external URLs are intentionally blocked here to prevent data exfiltration.
  'connect-src': ["'self'"],
  'worker-src': ["'self'", 'blob:'],
  'frame-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'upgrade-insecure-requests': true,
  'report-uri': '/api/csp-report',
};

/**
 * Build CSP header string from configuration
 *
 * @param config - CSP directive configuration
 * @returns CSP header value string
 *
 * @example
 * ```typescript
 * const csp = buildCSP(PRODUCTION_CSP);
 * // "default-src 'self'; script-src 'self'; ..."
 * ```
 */
export function buildCSP(config: CSPConfig): string {
  const directives: string[] = [];

  // Required directives
  directives.push(`default-src ${config['default-src'].join(' ')}`);
  directives.push(`script-src ${config['script-src'].join(' ')}`);
  directives.push(`style-src ${config['style-src'].join(' ')}`);
  directives.push(`img-src ${config['img-src'].join(' ')}`);
  directives.push(`media-src ${config['media-src'].join(' ')}`);
  directives.push(`font-src ${config['font-src'].join(' ')}`);
  directives.push(`connect-src ${config['connect-src'].join(' ')}`);
  directives.push(`worker-src ${config['worker-src'].join(' ')}`);
  directives.push(`frame-src ${config['frame-src'].join(' ')}`);
  directives.push(`frame-ancestors ${config['frame-ancestors'].join(' ')}`);
  directives.push(`form-action ${config['form-action'].join(' ')}`);
  directives.push(`base-uri ${config['base-uri'].join(' ')}`);
  directives.push(`object-src ${config['object-src'].join(' ')}`);

  // upgrade-insecure-requests is a value-less directive
  if (config['upgrade-insecure-requests']) {
    directives.push('upgrade-insecure-requests');
  }

  // Optional report-uri (production only, for monitoring CSP violations)
  if (config['report-uri']) {
    directives.push(`report-uri ${config['report-uri']}`);
  }

  return directives.join('; ');
}

/**
 * An exact `https://` origin, optionally wildcarded at the left-most label and
 * optionally with a port: `https://player.vimeo.com`, `https://*.example.com`.
 * The shape every list in `lib/app/csp.ts` is held to.
 *
 * Deliberately narrow. These values are spliced straight into a header, so a
 * `;`, a space, a bare `*`, or a `data:` scheme would either widen the policy
 * or break the directives that follow it.
 */
const APP_CSP_ORIGIN = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

/** How one list of fork-supplied origins is checked, and what a warning names. */
interface OriginRule {
  /** The directive the list feeds, e.g. `frame-src`. */
  directive: string;
  /** The fork file the list came from. */
  source: string;
  /** Whether one entry has an acceptable shape. */
  accepts: (origin: string) => boolean;
  /** An example of an acceptable entry, for the warning. */
  example: string;
}

/**
 * Keep the entries of a fork-supplied origin list that pass `rule`, once each,
 * logging the rest. An invalid entry is dropped rather than trusted: it would
 * be spliced into a header.
 */
function acceptOrigins(origins: readonly string[], rule: OriginRule): string[] {
  const accepted: string[] = [];

  for (const origin of origins) {
    if (rule.accepts(origin)) {
      if (!accepted.includes(origin)) accepted.push(origin);
      continue;
    }
    logger.warn(`Ignoring invalid ${rule.directive} origin from ${rule.source}`, {
      origin,
      expected: `an exact https:// origin, e.g. ${rule.example}`,
    });
  }

  return accepted;
}

/** The directives a fork may add origins to through `lib/app/csp.ts`. */
type AppCspDirective = 'script-src' | 'media-src' | 'connect-src' | 'frame-src';

/** Validate one `lib/app/csp.ts` list, paired with the directive it feeds. */
function appCspAddition(
  directive: AppCspDirective,
  origins: readonly string[],
  example: string
): readonly [AppCspDirective, string[]] {
  const rule: OriginRule = {
    directive,
    source: 'lib/app/csp.ts',
    accepts: (origin) => APP_CSP_ORIGIN.test(origin),
    example,
  };
  return [directive, acceptOrigins(origins, rule)];
}

/**
 * The fork's additions from `lib/app/csp.ts`, validated once at module load —
 * not per request, since the lists are constants. Empty in vanilla Sunrise.
 */
const APP_CSP_ADDITIONS = [
  appCspAddition('script-src', appScriptSrc, 'https://challenges.cloudflare.com'),
  appCspAddition('connect-src', appConnectSrc, 'https://api.example.com'),
  appCspAddition('media-src', appMediaSrc, 'https://media.example.com'),
  appCspAddition('frame-src', appFrameSrc, 'https://player.vimeo.com'),
];

/**
 * An exact origin a page may be framed by: `https://host[:port]`. No wildcard
 * and no path — unlike the `lib/app/csp.ts` lists, this one comes from a fork's
 * per-request answer (often stored data, such as the sites a customer named), so
 * it is held to the narrowest shape. Outside production `http://localhost[:port]`
 * is also accepted, so an embedding page can be tried locally.
 */
const FRAME_ANCESTOR_ORIGIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;
const LOCAL_FRAME_ANCESTOR_ORIGIN = /^http:\/\/localhost(:\d{1,5})?$/i;

/** The rule for `lib/app/frame-ancestors.ts` answers, checked per request. */
const FRAME_ANCESTORS_RULE: OriginRule = {
  directive: 'frame-ancestors',
  source: 'lib/app/frame-ancestors.ts',
  accepts: (origin) =>
    FRAME_ANCESTOR_ORIGIN.test(origin) ||
    (process.env.NODE_ENV !== 'production' && LOCAL_FRAME_ANCESTOR_ORIGIN.test(origin)),
  example: 'https://www.example.com',
};

/**
 * Get analytics provider domains for CSP allowlisting
 *
 * Reads configured analytics env vars and returns domains that need to be
 * allowed in script-src and connect-src for the provider to function.
 */
function getAnalyticsCSPDomains(): { scriptSrc: string[]; connectSrc: string[] } {
  const scriptSrc: string[] = [];
  const connectSrc: string[] = [];

  // PostHog - needs script loading, API calls, and CDN assets
  // PostHog uses a separate assets CDN (e.g., eu-assets.i.posthog.com for eu.i.posthog.com)
  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
    scriptSrc.push(host);
    connectSrc.push(host);

    // Derive assets CDN domain (eu.i.posthog.com → eu-assets.i.posthog.com)
    try {
      const url = new URL(host);
      const parts = url.hostname.split('.');
      if (parts.length >= 3) {
        parts[0] = `${parts[0]}-assets`;
        const assetsHost = `${url.protocol}//${parts.join('.')}`;
        scriptSrc.push(assetsHost);
        connectSrc.push(assetsHost);
      }
    } catch {
      // Invalid URL, skip assets domain
    }
  }

  // GA4 - needs gtag script and analytics endpoint
  if (process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID) {
    scriptSrc.push('https://www.googletagmanager.com');
    connectSrc.push(
      'https://www.google-analytics.com',
      'https://*.google-analytics.com',
      'https://www.googletagmanager.com'
    );
  }

  // Plausible - needs script loading and API calls
  if (process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN) {
    const host = process.env.NEXT_PUBLIC_PLAUSIBLE_HOST || 'https://plausible.io';
    scriptSrc.push(host);
    connectSrc.push(host);
  }

  return { scriptSrc, connectSrc };
}

/**
 * Get CSP configuration for current environment
 *
 * Automatically includes analytics provider domains when configured, and the
 * `script-src`, `connect-src`, `media-src` and `frame-src` origins the fork
 * declared in `lib/app/csp.ts`. Code that asks whether the policy allows a host
 * reads it here, so the additions must land here and not only in the header.
 *
 * @param nonce - Optional per-request nonce for inline script allowlisting
 * @returns CSP configuration object
 */
export function getCSPConfig(nonce?: string): CSPConfig {
  const base =
    process.env.NODE_ENV === 'production' ? { ...PRODUCTION_CSP } : { ...DEVELOPMENT_CSP };

  // Add per-request nonce to script-src (production only — dev already has 'unsafe-inline')
  if (nonce && process.env.NODE_ENV === 'production') {
    base['script-src'] = [...base['script-src'], `'nonce-${nonce}'`];
  }

  // Add the fork's own hosts (lib/app/csp.ts — every list empty in vanilla Sunrise)
  for (const [directive, origins] of APP_CSP_ADDITIONS) {
    if (origins.length > 0) {
      base[directive] = [...new Set([...base[directive], ...origins])];
    }
  }

  // Add analytics provider domains
  const analytics = getAnalyticsCSPDomains();
  if (analytics.scriptSrc.length > 0) {
    base['script-src'] = [...base['script-src'], ...analytics.scriptSrc];
  }
  if (analytics.connectSrc.length > 0) {
    base['connect-src'] = [...base['connect-src'], ...analytics.connectSrc];
  }

  return base;
}

/**
 * Get CSP header value for current environment
 *
 * @param nonce - Optional per-request nonce for inline script allowlisting
 * @returns CSP header string
 *
 * @example
 * ```typescript
 * const csp = getCSP(nonce);
 * response.headers.set('Content-Security-Policy', csp);
 * ```
 */
export function getCSP(nonce?: string): string {
  return buildCSP(getCSPConfig(nonce));
}

/** Per-request options for {@link setSecurityHeaders}. */
export interface SecurityHeaderOptions {
  /**
   * Exact origins allowed to frame this response, from the fork's
   * `lib/app/frame-ancestors.ts`. Empty or absent = `frame-ancestors 'none'`
   * and `X-Frame-Options: DENY`. Invalid entries are dropped with a warning.
   */
  frameAncestors?: readonly string[];
}

/**
 * Set all security headers on a NextResponse
 *
 * Headers set:
 * - Content-Security-Policy (environment-specific, nonce-based in production)
 * - X-Frame-Options: DENY (omitted when `options.frameAncestors` names a site)
 * - X-Content-Type-Options: nosniff
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - Permissions-Policy (disables geolocation, microphone, camera)
 * - Strict-Transport-Security (production only)
 *
 * NOTE: X-XSS-Protection is intentionally NOT set.
 * It's deprecated and can introduce XSS vulnerabilities in older browsers.
 * Modern browsers ignore it when CSP is present.
 *
 * @param response - NextResponse to add headers to
 * @param nonce - Per-request nonce to include in script-src
 * @param options - Per-request additions: the sites allowed to frame this response
 *
 * @example
 * ```typescript
 * // In proxy.ts middleware
 * const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
 * const response = NextResponse.next();
 * setSecurityHeaders(response, nonce);
 * return response;
 * ```
 */
export function setSecurityHeaders(
  response: NextResponse,
  nonce?: string,
  options: SecurityHeaderOptions = {}
): void {
  // The sites this response may be framed by, from the fork's
  // lib/app/frame-ancestors.ts. Empty (the default, and always in vanilla
  // Sunrise) keeps `frame-ancestors 'none'` and DENY below.
  const frameAncestors = acceptOrigins(options.frameAncestors ?? [], FRAME_ANCESTORS_RULE);

  // Content Security Policy - environment-specific, nonce-based in production
  const csp = getCSPConfig(nonce);
  if (frameAncestors.length > 0) csp['frame-ancestors'] = frameAncestors;
  response.headers.set('Content-Security-Policy', buildCSP(csp));

  if (frameAncestors.length > 0) {
    // X-Frame-Options cannot name a site (ALLOW-FROM is obsolete), so a
    // framable response must not carry it: browsers that honour
    // `frame-ancestors` ignore it anyway, and the rest would refuse the named
    // site. Deleted rather than left unset, so an earlier writer cannot leave
    // DENY behind.
    response.headers.delete('X-Frame-Options');
  } else {
    // Prevent clickjacking - DENY matches CSP frame-ancestors: 'none'
    // Note: CSP frame-ancestors supersedes this in modern browsers
    response.headers.set('X-Frame-Options', 'DENY');
  }

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Disable unnecessary browser features.
  // `microphone=(self)` allows the admin chat surface to invoke
  // `getUserMedia({ audio: true })` for voice input. The embed widget
  // mounts on the *parent* site via `<script>` + Shadow DOM, so it
  // inherits the parent site's Permissions-Policy — this header does
  // not unlock the mic on partner pages. Iframe embedders need
  // `allow="microphone"` on the iframe element.
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(self), camera=()');

  // HSTS in production only - enforces HTTPS
  if (process.env.NODE_ENV === 'production') {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  // NOTE: X-XSS-Protection is intentionally NOT set
  // - Deprecated by modern browsers
  // - Can introduce XSS vulnerabilities in older browsers
  // - CSP provides better XSS protection
}

/**
 * Extend CSP config for specific routes
 *
 * Useful for pages that need additional permissions (e.g., embedded content)
 *
 * @param additions - Partial CSP config to merge
 * @returns Extended CSP string
 *
 * @example
 * ```typescript
 * // Allow embedding YouTube videos on a specific page
 * const extendedCSP = extendCSP({
 *   'frame-src': ["'self'", 'https://www.youtube.com'],
 * });
 * ```
 */
export function extendCSP(additions: Partial<CSPConfig>): string {
  const base = getCSPConfig();
  const extended: CSPConfig = { ...base };

  // Array directive keys (excluding value-less and string directives)
  const arrayDirectives: (keyof Omit<CSPConfig, 'report-uri' | 'upgrade-insecure-requests'>)[] = [
    'default-src',
    'script-src',
    'style-src',
    'img-src',
    'media-src',
    'font-src',
    'connect-src',
    'worker-src',
    'frame-src',
    'frame-ancestors',
    'form-action',
    'base-uri',
    'object-src',
  ];

  // Merge arrays for each directive
  for (const key of arrayDirectives) {
    const additionValues = additions[key];
    if (additionValues && Array.isArray(additionValues)) {
      const baseValues = extended[key];
      // Create union of existing and new values
      extended[key] = [...new Set([...baseValues, ...additionValues])];
    }
  }

  // Handle report-uri separately (string, not array)
  if (additions['report-uri'] !== undefined) {
    extended['report-uri'] = additions['report-uri'];
  }

  return buildCSP(extended);
}
