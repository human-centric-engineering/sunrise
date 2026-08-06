/**
 * Input Sanitization Utilities
 *
 * Defense-in-depth XSS prevention utilities.
 * While React auto-escapes output, these utilities provide additional protection
 * for cases where raw HTML might be rendered or URLs are processed.
 *
 * Features:
 * - HTML entity encoding
 * - HTML tag stripping
 * - URL protocol validation
 * - Open redirect prevention
 * - Recursive object sanitization
 *
 * @example
 * ```typescript
 * import { escapeHtml, sanitizeUrl } from '@/lib/security/sanitize';
 *
 * const userInput = '<script>alert("xss")</script>';
 * const safe = escapeHtml(userInput);
 * // "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
 * ```
 */

/**
 * HTML entity encoding map
 * Covers the essential characters that need escaping to prevent XSS
 */
const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;',
  '`': '&#x60;',
  '=': '&#x3D;',
};

/**
 * Dangerous URL protocols that could execute code
 */
const DANGEROUS_PROTOCOLS = ['javascript:', 'data:', 'vbscript:', 'file:'];

/**
 * Characters removed from a URL before its scheme is inspected.
 *
 * Two groups, added for different reasons:
 *
 * - `\u0000-\u0020` and `\u007f` — the real bypass class. The WHATWG URL parser
 *   removes tab/newline/CR from anywhere in a URL and strips leading C0 controls
 *   before reading the scheme, so `java<TAB>script:` reaches the browser as
 *   `javascript:`. This is what @braintree/sanitize-url and DOMPurify strip for.
 * - The non-ASCII whitespace — NOT browser-executable. Scheme parsing fails on a
 *   non-ALPHA first character, so a BOM-prefixed `javascript:` is treated as a
 *   relative URL. It is here because `trim()`, which this replaced, removed it,
 *   and a guard that gets wider in one direction and narrower in another — with
 *   only the widening written down — is how a gap survives the next review.
 */
/* eslint-disable no-control-regex -- matching control chars is the point */
const URL_NORMALIZE_STRIP =
  /[\u0000-\u0020\u007f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g;
/* eslint-enable no-control-regex */

/**
 * Escape HTML entities to prevent XSS
 *
 * Use this for user-generated content that will be rendered as text.
 * React automatically escapes JSX children, so this is mainly for:
 * - dangerouslySetInnerHTML content
 * - Server-side HTML generation
 * - Email templates
 *
 * @param input - String to escape
 * @returns HTML-escaped string
 *
 * @example
 * ```typescript
 * const userBio = '<script>alert("xss")</script>';
 * const safeBio = escapeHtml(userBio);
 * // "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;"
 * ```
 */
export function escapeHtml(input: string): string {
  if (!input || typeof input !== 'string') return '';
  return input.replace(/[&<>"'`=/]/g, (char) => HTML_ENTITIES[char] ?? char);
}

/**
 * Strip all HTML tags from input
 *
 * Use when HTML should not be preserved at all.
 * Useful for search queries, plaintext displays, etc.
 *
 * @param input - String to strip
 * @returns String with all HTML tags removed
 *
 * @example
 * ```typescript
 * const html = '<p>Hello <strong>World</strong></p>';
 * const text = stripHtml(html);
 * // "Hello World"
 * ```
 */
export function stripHtml(input: string): string {
  if (!input || typeof input !== 'string') return '';
  // Remove HTML tags but preserve content between them. The loop re-runs the
  // strip until the string stops changing: it guarantees idempotence and
  // defends against any future narrowing of the pattern that could leave a
  // re-formable tag. This yields plaintext — it is NOT an XSS-safe sanitiser;
  // use a dedicated sanitiser (e.g. DOMPurify) before rendering as HTML.
  let prev: string;
  let out = input;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, '');
  } while (out !== prev);
  return out;
}

/**
 * Sanitize a URL to prevent javascript: protocol attacks
 *
 * Blocks dangerous protocols that could execute code:
 * - javascript:
 * - data: (can embed scripts)
 * - vbscript:
 * - file:
 *
 * @param url - URL to sanitize
 * @returns Safe URL or empty string if dangerous
 *
 * @example
 * ```typescript
 * sanitizeUrl('https://example.com'); // 'https://example.com'
 * sanitizeUrl('javascript:alert(1)'); // ''
 * sanitizeUrl('data:text/html,...');  // ''
 * ```
 */
export function sanitizeUrl(url: string): string {
  if (!url || typeof url !== 'string') return '';

  // Strip ASCII control characters, space, DEL and unicode whitespace BEFORE
  // the scheme check, so the guard inspects what the browser will actually parse.
  //
  // The WHATWG URL parser removes tab (U+0009), newline (U+000A) and carriage
  // return (U+000D) from ANYWHERE in a URL, and strips leading C0 controls,
  // before it reads the scheme. `String.prototype.trim()` only removes
  // leading/trailing whitespace, so an exact `startsWith` on the trimmed string
  // missed every one of these while the browser still executed them:
  //
  //   'java\tscript:alert(1)'   — tab inside the scheme
  //   'java\nscript:alert(1)'   — newline inside the scheme
  //   'javascript\t:alert(1)'   — tab before the colon
  //   '\x01javascript:alert(1)' — leading C0 control (trim removes whitespace,
  //                               not \x01-\x08 / \x0e-\x1f)
  //
  // This is the known sanitizer-bypass class that @braintree/sanitize-url and
  // DOMPurify strip for. Only the inspected COPY is stripped; the original is
  // what gets returned, so a legitimate URL is never rewritten.
  //
  // See `URL_NORMALIZE_STRIP` for why the class also covers non-ASCII whitespace.
  const normalized = url.replace(URL_NORMALIZE_STRIP, '').toLowerCase();

  // Check for dangerous protocols
  for (const protocol of DANGEROUS_PROTOCOLS) {
    if (normalized.startsWith(protocol)) {
      return '';
    }
  }

  return url;
}

/**
 * Validate and sanitize a redirect URL to prevent open redirects
 *
 * Only allows:
 * - Relative paths (same-origin)
 * - Explicitly whitelisted external hosts
 *
 * @param url - URL to validate
 * @param baseUrl - Base URL of the application
 * @param allowedHosts - Optional array of allowed external hosts
 * @returns Safe redirect path/URL or '/' if invalid
 *
 * @example
 * ```typescript
 * const base = 'https://app.example.com';
 *
 * // Same-origin redirect - allowed
 * sanitizeRedirectUrl('/dashboard', base);
 * // '/dashboard'
 *
 * // External redirect - blocked
 * sanitizeRedirectUrl('https://evil.com', base);
 * // '/'
 *
 * // Whitelisted external - allowed
 * sanitizeRedirectUrl('https://docs.example.com', base, ['docs.example.com']);
 * // 'https://docs.example.com'
 * ```
 */
export function sanitizeRedirectUrl(
  url: string,
  baseUrl: string,
  allowedHosts: string[] = []
): string {
  if (!url || typeof url !== 'string') return '/';

  try {
    // Parse URLs
    const parsed = new URL(url, baseUrl);
    const base = new URL(baseUrl);

    // Allow same-origin redirects
    if (parsed.origin === base.origin) {
      // Return only the path portion for same-origin
      return parsed.pathname + parsed.search + parsed.hash;
    }

    // Allow whitelisted external hosts
    if (allowedHosts.includes(parsed.host)) {
      return url;
    }

    // Block all other external redirects
    return '/';
  } catch {
    // Invalid URL - return safe default
    return '/';
  }
}

/**
 * Validate that a callback URL is a safe relative path
 *
 * Use this in client components where a base URL is not readily available.
 * Only allows paths starting with `/` (but not `//` which browsers treat
 * as protocol-relative URLs).
 *
 * @param url - URL to validate
 * @param fallback - Fallback path if URL is unsafe (default: '/')
 * @returns Safe relative path or fallback
 *
 * @example
 * ```typescript
 * safeCallbackUrl('/dashboard');            // '/dashboard'
 * safeCallbackUrl('https://evil.com');      // '/'
 * safeCallbackUrl('//evil.com');            // '/'
 * safeCallbackUrl('javascript:alert(1)');   // '/'
 * ```
 */
export function safeCallbackUrl(url: string | null, fallback: string = '/'): string {
  if (!url || typeof url !== 'string') return fallback;
  return normalizeRootRelativePath(url.trim()) ?? fallback;
}

/**
 * ASCII tab, LF and CR — removed by the WHATWG URL parser from *anywhere* in
 * the input, before it reads the authority.
 *
 * Deliberately NOT `URL_NORMALIZE_STRIP`, which covers the whole C0-plus-space
 * range. That is right for scheme inspection, where the normalized value is
 * only ever compared — but a root-relative path is **returned and navigated
 * to**, and the wider class includes U+0020, which would silently rewrite a
 * legitimate `/search?q=two words` into `/search?q=twowords`.
 */
const URL_AUTHORITY_STRIP = /[\t\n\r]/g;

/**
 * Normalize `path` the way the URL parser will, and return it only if what the
 * parser ends up seeing is genuinely same-origin. Returns `null` otherwise.
 *
 * Callers must use the **returned** string rather than the one they passed in.
 * That is the point of returning it: judging one value and navigating to a
 * different one is what re-opens the hole this closes.
 *
 * Rejects a leading `//` (protocol-relative) AND a leading `/\` — the parser
 * normalizes a backslash to a forward slash for "special" schemes
 * (http/https/ws/wss/ftp/file) before reading the authority, so `/\evil.com`
 * resolves to `//evil.com`, a different origin, without literally starting
 * with `//`.
 *
 * It also rejects those forms once tab/LF/CR are removed. The parser deletes
 * those characters wherever they appear, so `/<TAB>/evil.com` survives a
 * `trim()` and a naive `path[1]` test and then collapses to `//evil.com`:
 * `new URL('/\t/evil.com', 'https://good.example.com').href` is
 * `'https://evil.com/'`. Same class as the scheme bypass `sanitizeUrl()`
 * closes; this is the other guard in this file, which it never reached.
 */
export function normalizeRootRelativePath(path: string): string | null {
  const seen = path.replace(URL_AUTHORITY_STRIP, '');
  if (!seen.startsWith('/') || seen[1] === '/' || seen[1] === '\\') return null;
  return seen;
}

/**
 * True if `path` is a root-relative path safe to redirect to same-origin.
 *
 * Prefer {@link normalizeRootRelativePath} when the value will be navigated
 * to — a `true` here means the *normalized* form is safe, and the raw string
 * you passed in may still differ from what the URL parser acts on.
 */
export function isRootRelativePath(path: string): boolean {
  return normalizeRootRelativePath(path) !== null;
}

import { isRecord } from '@/lib/utils';

/**
 * Recursively sanitize all string values in an object
 *
 * Applies a sanitization function to every string value in a nested object.
 * Useful for sanitizing form submissions or API payloads.
 *
 * @param obj - Object to sanitize
 * @param sanitizer - Sanitization function to apply (default: escapeHtml)
 * @returns Sanitized copy of the object
 *
 * @example
 * ```typescript
 * const formData = {
 *   name: '<script>alert(1)</script>',
 *   bio: 'Hello <b>World</b>',
 *   nested: {
 *     value: '<img onerror="alert(1)">'
 *   }
 * };
 *
 * const safe = sanitizeObject(formData);
 * // All string values are HTML-escaped
 * ```
 */
export function sanitizeObject<T extends Record<string, unknown>>(
  obj: T,
  sanitizer: (s: string) => string = escapeHtml
): T {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = sanitizer(value);
    } else if (isRecord(value)) {
      result[key] = sanitizeObject(value, sanitizer);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item: unknown): unknown => {
        if (typeof item === 'string') {
          return sanitizer(item);
        } else if (isRecord(item)) {
          return sanitizeObject(item, sanitizer);
        }
        // Non-string, non-object items are passed through unchanged
        return item;
      });
    } else {
      result[key] = value;
    }
  }

  // SAFETY: The assertion is sound — we iterate every key of `obj` and only
  // transform string values via `sanitizer`, preserving all keys and non-string
  // values unchanged. The structural shape of `T` is therefore maintained.
  return result as T;
}

/**
 * Sanitize a filename to prevent path traversal attacks
 *
 * Removes:
 * - Directory traversal sequences (../, ..\)
 * - Absolute path indicators (/, \)
 * - Null bytes
 * - Control characters
 *
 * @param filename - Filename to sanitize
 * @returns Safe filename
 *
 * @example
 * ```typescript
 * sanitizeFilename('../../../etc/passwd');
 * // 'etc_passwd'
 *
 * sanitizeFilename('normal-file.pdf');
 * // 'normal-file.pdf'
 * ```
 */
export function sanitizeFilename(filename: string): string {
  if (!filename || typeof filename !== 'string') return '';

  // Strip traversal sequences repeatedly until stable. A single pass is
  // non-idempotent — e.g. `....//` collapses to `../`, which would survive.
  let out = filename.replace(/\0/g, '');
  let prev: string;
  do {
    prev = out;
    out = out.replace(/\.\.[/\\]/g, '');
  } while (out !== prev);

  return (
    out
      // Remove absolute path indicators
      .replace(/^\//, '')
      .replace(/^\\/, '')
      // Replace path separators with underscores
      .replace(/[/\\]/g, '_')
      // Remove control characters (but preserve unicode)
      // eslint-disable-next-line no-control-regex -- Intentionally removing control chars for security
      .replace(/[\x00-\x1f\x7f]/g, '')
      // Limit length
      .slice(0, 255)
  );
}
