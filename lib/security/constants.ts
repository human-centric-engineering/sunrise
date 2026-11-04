/**
 * Security Constants
 *
 * Centralized configuration for security features.
 * These values follow OWASP recommendations and industry best practices.
 *
 * Rate limits are tunable via env vars (use in `.env.local` to loosen them on
 * dev without touching prod). Each `LIMITS.*` count below routes through
 * `envInt(name, fallback)`, so a positive-integer override wins and anything
 * else (unset, non-numeric, ≤ 0) falls back to the documented default.
 *
 * Section tiers (applied by the rate-limit middleware):
 *   - `RATE_LIMIT_API`        — general API (default 100/min)
 *   - `RATE_LIMIT_ADMIN`      — core admin endpoints (default 30/min)
 *   - `RATE_LIMIT_ORCH_ADMIN` — admin/orchestration endpoints (default 120/min)
 *   - `RATE_LIMIT_MCP`        — MCP transport endpoint (default 300/min)
 *   - `RATE_LIMIT_AUTH`       — authentication endpoints (default 5/min)
 *
 * Per-flow sub-caps (applied additively inside route handlers):
 *   - `RATE_LIMIT_PASSWORD_RESET` (3), `RATE_LIMIT_CONTACT` (5), `RATE_LIMIT_WAITLIST` (5),
 *     `RATE_LIMIT_ACCEPT_INVITE` (5), `RATE_LIMIT_UPLOAD` (10),
 *     `RATE_LIMIT_INVITE` (10), `RATE_LIMIT_CSP_REPORT` (20),
 *     `RATE_LIMIT_CHAT` (20), `RATE_LIMIT_CONSUMER_CHAT` (10),
 *     `RATE_LIMIT_AUDIO` (10), `RATE_LIMIT_EXPORT` (10), `RATE_LIMIT_IMAGE` (20),
 *     `RATE_LIMIT_CLEANUP_REFINE` (12)
 *
 * The `*_INTERVAL` windows are intentionally NOT env-tunable — they encode
 * OWASP-aligned brute-force/abuse windows that shouldn't drift per deployment.
 */

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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
      /** Auth endpoints: 5 attempts per minute (override with `RATE_LIMIT_AUTH`) */
      AUTH: envInt('RATE_LIMIT_AUTH', 5),
      /** General API: 100 requests per minute (override with `RATE_LIMIT_API`) */
      API: envInt('RATE_LIMIT_API', 100),
      /** Admin endpoints: 30 requests per minute (override with `RATE_LIMIT_ADMIN`) */
      ADMIN: envInt('RATE_LIMIT_ADMIN', 30),
      /** Admin/orchestration endpoints: 120 requests per minute (override with `RATE_LIMIT_ORCH_ADMIN`) */
      ORCH_ADMIN: envInt('RATE_LIMIT_ORCH_ADMIN', 120),
      /**
       * MCP transport endpoint: 300 requests per minute, keyed per API key
       * (override with `RATE_LIMIT_MCP`).
       *
       * MCP is server-to-server traffic — LLM agents iterating through tool
       * calls inside a conversation. The traffic shape is much burstier than
       * human-driven API use, so the section cap is higher; per-customer
       * budgets are enforced separately by `McpRateLimiter` against the
       * `apiKey.rateLimit` field.
       */
      MCP: envInt('RATE_LIMIT_MCP', 300),
      /** Password reset: 3 attempts per 15 minutes (override with `RATE_LIMIT_PASSWORD_RESET`) */
      PASSWORD_RESET: envInt('RATE_LIMIT_PASSWORD_RESET', 3),
      /** Password reset window: 15 minutes */
      PASSWORD_RESET_INTERVAL: 15 * 60 * 1000,
      /** Contact form: 5 submissions per hour (override with `RATE_LIMIT_CONTACT`) */
      CONTACT: envInt('RATE_LIMIT_CONTACT', 5),
      /** Contact form window: 1 hour */
      CONTACT_INTERVAL: 60 * 60 * 1000,
      /** Waitlist joins: 5 per hour per IP (override with `RATE_LIMIT_WAITLIST`) */
      WAITLIST: envInt('RATE_LIMIT_WAITLIST', 5),
      /** Waitlist join window: 1 hour */
      WAITLIST_INTERVAL: 60 * 60 * 1000,
      /** Accept invite: 5 attempts per 15 minutes (override with `RATE_LIMIT_ACCEPT_INVITE`) */
      ACCEPT_INVITE: envInt('RATE_LIMIT_ACCEPT_INVITE', 5),
      /** Upload: 10 uploads per 15 minutes (override with `RATE_LIMIT_UPLOAD`) */
      UPLOAD: envInt('RATE_LIMIT_UPLOAD', 10),
      /** Upload window: 15 minutes */
      UPLOAD_INTERVAL: 15 * 60 * 1000,
      /** Invite: 10 invitations per 15 minutes (override with `RATE_LIMIT_INVITE`) */
      INVITE: envInt('RATE_LIMIT_INVITE', 10),
      /** Invite window: 15 minutes */
      INVITE_INTERVAL: 15 * 60 * 1000,
      /** CSP report: 20 reports per minute (override with `RATE_LIMIT_CSP_REPORT`) */
      CSP_REPORT: envInt('RATE_LIMIT_CSP_REPORT', 20),
      /** Chat stream (admin): 20 messages per minute per user (override with `RATE_LIMIT_CHAT`) */
      CHAT: envInt('RATE_LIMIT_CHAT', 20),
      /** Chat stream (consumer): 10 messages per minute per user (override with `RATE_LIMIT_CONSUMER_CHAT`) */
      CONSUMER_CHAT: envInt('RATE_LIMIT_CONSUMER_CHAT', 10),
      /** Audio transcription: 10 requests per minute per user/session (override with `RATE_LIMIT_AUDIO`) */
      AUDIO: envInt('RATE_LIMIT_AUDIO', 10),
      /**
       * Conversation export (admin): 10 requests per minute per user
       * (override with `RATE_LIMIT_EXPORT`). Per-flow sub-cap on top of the
       * orchestration section tier. Export routes are bulk reads — building a
       * JSON/CSV file from many rows — so they get a dedicated bucket that's
       * tighter than the section cap.
       */
      EXPORT: envInt('RATE_LIMIT_EXPORT', 10),
      /** Image / PDF attachment chat turn: 20 requests per minute per user/session (override with `RATE_LIMIT_IMAGE`) */
      IMAGE: envInt('RATE_LIMIT_IMAGE', 20),
      /**
       * Document Clean Up section-refine (direct editor, not chat): 12
       * requests per minute per user (override with `RATE_LIMIT_CLEANUP_REFINE`).
       * Mirrors the `rewrite_section_with_llm` capability's own rate limit
       * (see `prisma/seeds/019-cleanup-capabilities.ts`) so the inline editor
       * path — which calls the LLM provider directly, bypassing the
       * capability dispatcher — gets the same protection.
       */
      CLEANUP_REFINE: envInt('RATE_LIMIT_CLEANUP_REFINE', 12),
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
