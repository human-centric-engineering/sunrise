/**
 * Security Utilities Module
 *
 * Centralized security features for the Sunrise application.
 *
 * Features:
 * - Rate limiting (LRU cache-based)
 * - Security headers (environment-aware CSP)
 * - Input sanitization (XSS prevention)
 * - CORS configuration
 *
 * @example
 * ```typescript
 * import {
 *   authLimiter,
 *   setSecurityHeaders,
 *   escapeHtml,
 *   handlePreflight,
 * } from '@/lib/security';
 * ```
 */

// Rate limiting
export {
  createRateLimiter,
  authLimiter,
  apiLimiter,
  passwordResetLimiter,
  getRateLimitHeaders,
  createRateLimitResponse,
} from '@/lib/security/rate-limit';
export type { RateLimitOptions, RateLimitResult, RateLimiter } from '@/lib/security/rate-limit';

// Security headers
export {
  buildCSP,
  getCSP,
  getCSPConfig,
  setSecurityHeaders,
  extendCSP,
} from '@/lib/security/headers';
export type { CSPConfig } from '@/lib/security/headers';

// Input sanitization
export {
  escapeHtml,
  stripHtml,
  sanitizeUrl,
  sanitizeRedirectUrl,
  safeCallbackUrl,
  sanitizeObject,
  sanitizeFilename,
} from '@/lib/security/sanitize';

// CORS
export {
  isOriginAllowed,
  setCORSHeaders,
  handlePreflight,
  withCORS,
  createCORSHandlers,
} from '@/lib/security/cors';
export type { CORSOptions } from '@/lib/security/cors';

// Constants
export { SECURITY_CONSTANTS } from '@/lib/security/constants';
