/**
 * Security Constants
 *
 * Centralized configuration for security features.
 * These values follow OWASP recommendations and industry best practices.
 */

export const SECURITY_CONSTANTS = {
  /**
   * Rate limiting configuration
   * Based on OWASP brute force prevention guidelines
   */
  RATE_LIMIT: {
    /** Default time window in milliseconds (1 minute) */
    DEFAULT_INTERVAL: 60 * 1000,
    /** Maximum unique tokens (IPs) to track before LRU eviction */
    MAX_UNIQUE_TOKENS: 500,
    /** Rate limits by endpoint type */
    LIMITS: {
      /** Auth endpoints: 5 attempts per minute */
      AUTH: 5,
      /** General API: 100 requests per minute */
      API: 100,
      /** Password reset: 3 attempts per 15 minutes */
      PASSWORD_RESET: 3,
      /** Password reset window: 15 minutes */
      PASSWORD_RESET_INTERVAL: 15 * 60 * 1000,
    },
  },

  /**
   * CSP nonce configuration
   */
  CSP: {
    /** Length of nonce in bytes (16 bytes = 22 base64 chars) */
    NONCE_LENGTH: 16,
  },

  /**
   * CORS configuration
   */
  CORS: {
    /** Preflight cache duration in seconds (24 hours) */
    MAX_AGE: 86400,
    /** Allowed HTTP methods */
    METHODS: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    /** Default allowed headers */
    ALLOWED_HEADERS: ['Content-Type', 'Authorization', 'X-Request-ID'],
    /** Headers exposed to client */
    EXPOSED_HEADERS: [
      'X-Request-ID',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'X-RateLimit-Reset',
    ],
  },
} as const;
