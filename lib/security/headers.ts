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

/**
 * Content Security Policy directive configuration
 */
export interface CSPConfig {
  'default-src': string[];
  'script-src': string[];
  'style-src': string[];
  'img-src': string[];
  'font-src': string[];
  'connect-src': string[];
  'frame-ancestors': string[];
  'form-action': string[];
  'base-uri': string[];
  'object-src': string[];
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
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'webpack://*', 'ws://localhost:*', 'wss://localhost:*'],
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
  'img-src': ["'self'", 'data:', 'https:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'report-uri': '/api/csp-report', // Optional: enable violation reporting
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
  directives.push(`font-src ${config['font-src'].join(' ')}`);
  directives.push(`connect-src ${config['connect-src'].join(' ')}`);
  directives.push(`frame-ancestors ${config['frame-ancestors'].join(' ')}`);
  directives.push(`form-action ${config['form-action'].join(' ')}`);
  directives.push(`base-uri ${config['base-uri'].join(' ')}`);
  directives.push(`object-src ${config['object-src'].join(' ')}`);

  // Optional report-uri (production only, for monitoring CSP violations)
  if (config['report-uri']) {
    directives.push(`report-uri ${config['report-uri']}`);
  }

  return directives.join('; ');
}

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
 * Automatically includes analytics provider domains when configured.
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

/**
 * Set all security headers on a NextResponse
 *
 * Headers set:
 * - Content-Security-Policy (environment-specific, nonce-based in production)
 * - X-Frame-Options: SAMEORIGIN
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
export function setSecurityHeaders(response: NextResponse, nonce?: string): void {
  // Content Security Policy - environment-specific, nonce-based in production
  response.headers.set('Content-Security-Policy', getCSP(nonce));

  // Prevent clickjacking - DENY matches CSP frame-ancestors: 'none'
  // Note: CSP frame-ancestors supersedes this in modern browsers
  response.headers.set('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // Control referrer information
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Disable unnecessary browser features
  response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

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

  // Array directive keys (excluding report-uri which is a string)
  const arrayDirectives: (keyof Omit<CSPConfig, 'report-uri'>)[] = [
    'default-src',
    'script-src',
    'style-src',
    'img-src',
    'font-src',
    'connect-src',
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
