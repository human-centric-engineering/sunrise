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
  // Remove HTML tags but preserve content between them
  return input.replace(/<[^>]*>/g, '');
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

  const normalized = url.trim().toLowerCase();

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
 * Type guard for record objects
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

  return (
    filename
      // Remove null bytes
      .replace(/\0/g, '')
      // Remove path traversal
      .replace(/\.\.\//g, '')
      .replace(/\.\.\\/g, '')
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
