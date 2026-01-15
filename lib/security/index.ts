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
} from './rate-limit';
export type { RateLimitOptions, RateLimitResult, RateLimiter } from './rate-limit';

// Security headers
export { buildCSP, getCSP, getCSPConfig, setSecurityHeaders, extendCSP } from './headers';
export type { CSPConfig } from './headers';

// Input sanitization
export {
  escapeHtml,
  stripHtml,
  sanitizeUrl,
  sanitizeRedirectUrl,
  sanitizeObject,
  sanitizeFilename,
} from './sanitize';

// CORS
export {
  isOriginAllowed,
  setCORSHeaders,
  handlePreflight,
  withCORS,
  createCORSHandlers,
} from './cors';
export type { CORSOptions } from './cors';

// Constants
export { SECURITY_CONSTANTS } from './constants';
