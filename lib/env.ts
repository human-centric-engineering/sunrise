import { z } from 'zod';
import { appEnvSchema } from '@/lib/app/env';

/**
 * Environment Variable Validation Schema
 *
 * This file centralizes all environment variable validation using Zod.
 * Variables are validated at application startup with fail-fast behavior.
 *
 * ⚠️ IMPORTANT: SERVER-SIDE ONLY
 * This module should ONLY be imported in server-side code:
 * - ✅ Server components (no 'use client')
 * - ✅ API routes (app/api/*\/route.ts)
 * - ✅ Server actions ('use server')
 * - ✅ Middleware (middleware.ts)
 * - ✅ Server utilities (lib/db, lib/auth/config.ts, etc.)
 *
 * ❌ NEVER import this in client-side code:
 * - ❌ Client components ('use client')
 * - ❌ Client utilities (lib/auth/client.ts)
 * - ❌ Browser-only code
 *
 * For client-side code, access NEXT_PUBLIC_* variables directly:
 * const appUrl = process.env.NEXT_PUBLIC_APP_URL
 *
 * @see .context/environment/overview.md for setup guide and usage patterns
 * @see .context/environment/reference.md for complete variable reference
 */

// Server-only environment variables
const serverEnvSchema = z.object({
  // Database
  DATABASE_URL: z.string().url({
    message:
      'DATABASE_URL must be a valid PostgreSQL connection string (e.g., postgresql://user:password@localhost:5432/dbname)',
  }),
  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum pg connections held by this process. Defaults to 10, which suits one ' +
        'long-running server (docker-compose, Render, Railway). On a function-per-request ' +
        'platform every warm instance holds its own pool, so set 1 and put a transaction ' +
        'pooler in front. See .context/environment/database-env.md.'
    ),

  // Authentication (better-auth)
  BETTER_AUTH_URL: z.string().url({
    message:
      'BETTER_AUTH_URL must be a valid URL (e.g., http://localhost:3000 for local development)',
  }),
  BETTER_AUTH_SECRET: z.string().min(32, {
    message:
      'BETTER_AUTH_SECRET must be at least 32 characters. Generate with: openssl rand -base64 32',
  }),

  // Signup model (see .context/auth/signup-modes.md)
  SIGNUP_MODE: z
    .enum(['open', 'invite_only'])
    .default('open')
    .describe(
      'Who may create an account. "open" (default) = anyone may sign up, the right default ' +
        'for a starter template. "invite_only" = accounts are only created by accepting an ' +
        'admin invitation; both the email/password endpoint and un-invited OAuth signup are ' +
        'refused. The first human on an empty database may still sign up (and becomes ADMIN) ' +
        'so a fresh deployment has an operator to send invitations — that window closes ' +
        'permanently once any human exists. See lib/auth/signup-mode.ts.'
    ),

  // OAuth Providers (optional)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Email (optional for Phase 1, required in Phase 3)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
  EMAIL_FROM_NAME: z.string().optional(),
  CONTACT_EMAIL: z
    .string()
    .email()
    .optional()
    .describe('Email address for contact form notifications (defaults to EMAIL_FROM)'),
  REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (val === 'true') return true;
      if (val === 'false') return false;
      return undefined;
    })
    .describe('Require email verification (defaults to true in production, false in development)'),

  // App Configuration
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Tenancy model (see .context/architecture/multi-tenancy.md)
  TENANCY_MODE: z
    .enum(['single', 'multi'])
    .default('single')
    .describe(
      'Deployment tenancy model. "single" (default) = standard single-tenant install. ' +
        '"multi" is NOT implemented by the template — it requires the Postgres-RLS retrofit ' +
        'in .context/architecture/multi-tenancy.md. Setting "multi" without that work makes the ' +
        'Prisma client throw at startup (see the tenancy seam in lib/db/client.ts) rather than ' +
        'silently run unscoped queries.'
    ),

  // Capability authorization model (see lib/orchestration/capabilities/dispatcher.ts)
  CAPABILITY_BINDING_MODE: z
    .enum(['permissive', 'strict'])
    .default('permissive')
    .describe(
      'How the capability dispatcher treats a MISSING `AiAgentCapability` row. ' +
        '"permissive" (default) synthesizes a default-allow binding, so deleting a grant does ' +
        'NOT revoke a capability — it widens it, by dropping any customConfig pin. Revoke by ' +
        'setting isEnabled:false and keeping the row. "strict" makes a missing row deny instead. ' +
        'Strict is opt-in because it retroactively revokes every capability an agent relied on ' +
        'implicitly, including the mcp-system agent, which dispatches built-ins with no pivot ' +
        'rows in a default install — audit AiAgentCapability before enabling it.'
    ),

  // Logging Configuration (optional)
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .optional()
    .describe('Logging verbosity level. Defaults to "debug" in development, "info" in production'),

  // Anonymous visitor observability (see .context/logging/visitor-tracing.md).
  // These are read directly from process.env in lib/logging/visitor-id.ts
  // (so they work in the proxy runtime); registered here for documentation
  // and fail-fast validation only.
  LOG_VISITOR_ID: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'Durable signed anonymous visitor-id cookie + log field for cross-request tracing. ' +
        'Default ON (security/observability feature). Set "false" to disable entirely.'
    ),
  LOG_HTTP_ACCESS: z
    .enum(['true', 'false'])
    .optional()
    .describe(
      'Emit one structured access-log line per request from the proxy (requestId, visitorId, ' +
        'method, path). Default OFF — opt in with "true" to make navigation visible server-side.'
    ),

  // Internal self-calls (optional)
  INTERNAL_API_URL: z
    .string()
    .url({ message: 'INTERNAL_API_URL must be a valid URL (e.g., http://127.0.0.1:3000)' })
    .optional()
    .describe(
      "Base URL server components use to call this app's own API (lib/api/server-fetch.ts). " +
        'Defaults to loopback in development and BETTER_AUTH_URL otherwise. Set it when the ' +
        'public URL is not reachable from inside the server — e.g. a local reverse proxy whose ' +
        'TLS certificate Node does not trust, or a private network where the public hostname ' +
        'resolves elsewhere.'
    ),

  // Security Configuration (optional)
  ALLOWED_ORIGINS: z
    .string()
    .optional()
    .describe(
      'Comma-separated list of allowed CORS origins (e.g., https://app.example.com,https://mobile.example.com). Leave unset for same-origin only.'
    ),

  // Analytics - Server-side API keys (optional)
  GA4_API_SECRET: z
    .string()
    .optional()
    .describe('GA4 API secret for server-side Measurement Protocol tracking'),
});

// Client-side environment variables (NEXT_PUBLIC_* vars)
const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url({
    message:
      'NEXT_PUBLIC_APP_URL must be a valid URL (embedded at build time, must match BETTER_AUTH_URL for consistency)',
  }),

  // Brand display name (optional - defaults to "Sunrise"). Consumed via
  // `lib/brand.ts` (`BRAND.name`), which reads process.env directly so it is
  // client-safe; registered here for validation/documentation.
  NEXT_PUBLIC_APP_NAME: z
    .string()
    .optional()
    .describe('Display name for the app brand (layout titles, emails). Defaults to "Sunrise".'),

  // Consumed via `lib/brand.ts` (`BRAND.legalName`), same client-safe pattern as
  // NEXT_PUBLIC_APP_NAME. Copyright holder / legal entity for the footer
  // copyright (and future legal surfaces); defaults to the product name.
  NEXT_PUBLIC_LEGAL_NAME: z
    .string()
    .optional()
    .describe('Legal entity / copyright holder for the footer. Defaults to NEXT_PUBLIC_APP_NAME.'),

  // Analytics (optional - auto-detected based on available credentials)
  NEXT_PUBLIC_ANALYTICS_PROVIDER: z
    .enum(['ga4', 'posthog', 'plausible', 'console'])
    .optional()
    .describe('Explicit analytics provider selection (auto-detects if not set)'),

  // Google Analytics 4
  NEXT_PUBLIC_GA4_MEASUREMENT_ID: z
    .string()
    .optional()
    .describe('GA4 Measurement ID (G-XXXXXXXXXX)'),

  // PostHog
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional().describe('PostHog project API key'),
  NEXT_PUBLIC_POSTHOG_HOST: z
    .string()
    .url()
    .optional()
    .describe('PostHog host URL (defaults to https://us.i.posthog.com)'),

  // Plausible
  NEXT_PUBLIC_PLAUSIBLE_DOMAIN: z.string().optional().describe('Domain registered in Plausible'),
  NEXT_PUBLIC_PLAUSIBLE_HOST: z
    .string()
    .url()
    .optional()
    .describe('Plausible host URL (defaults to https://plausible.io)'),
});

// Combined schema for type inference.
//
// `appEnvSchema` (fork-readiness seam 11) folds any app-declared server-side
// vars into the same fail-fast parse below, so forks extend the environment
// contract by editing `lib/app/env.ts` — never this core schema. It is merged
// into the server side only; the browser path validates `clientEnvSchema`
// alone, so app server vars are never required (or leaked) client-side.
//
// SECURITY: Zod `.merge()` is right-wins, so a fork that puts a colliding key
// in `appEnvSchema` (e.g. `DATABASE_URL: z.string().optional()`) would silently
// weaken the core requirement — `safeParse(process.env)` would succeed without
// `DATABASE_URL`, breaking the fail-fast promise this module advertises and
// surfacing the failure later as a Prisma crash. Reject collisions here at
// module load so the boot output names the offending key(s).
const coreServerKeys = new Set(Object.keys(serverEnvSchema.shape));
const coreClientKeys = new Set(Object.keys(clientEnvSchema.shape));
const appKeyCollisions = Object.keys(appEnvSchema.shape).filter(
  (key) => coreServerKeys.has(key) || coreClientKeys.has(key)
);
if (appKeyCollisions.length > 0) {
  throw new Error(
    `lib/app/env.ts redeclares core Sunrise env key(s): ${appKeyCollisions.join(', ')}. ` +
      'Forks may extend the schema but must not override core keys (right-wins merge would ' +
      'silently weaken core validation). Rename the colliding key(s) in your appEnvSchema. ' +
      'See .context/environment/overview.md.'
  );
}

const envSchema = serverEnvSchema.merge(appEnvSchema).merge(clientEnvSchema);

/**
 * Validated environment variables with type safety.
 *
 * Import this instead of using process.env directly:
 * ```typescript
 * import { env } from '@/lib/env'
 * const dbUrl = env.DATABASE_URL // Type-safe!
 * ```
 */
export type Env = z.infer<typeof envSchema>;

// Check if we're running in a browser
const isBrowser = typeof window !== 'undefined';

// Parse and validate environment variables
// On the client, only validate NEXT_PUBLIC_* variables
// On the server, validate all variables
//
// IMPORTANT: In the browser, we must explicitly construct the env object
// because Next.js only does static replacement for direct property access
// (e.g., process.env.NEXT_PUBLIC_APP_URL), not when passing the entire
// process.env object to a function.
const parsed = isBrowser
  ? clientEnvSchema.safeParse({
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
      NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
      NEXT_PUBLIC_LEGAL_NAME: process.env.NEXT_PUBLIC_LEGAL_NAME,
      // Analytics (optional)
      NEXT_PUBLIC_ANALYTICS_PROVIDER: process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER,
      NEXT_PUBLIC_GA4_MEASUREMENT_ID: process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID,
      NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
      NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      NEXT_PUBLIC_PLAUSIBLE_DOMAIN: process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN,
      NEXT_PUBLIC_PLAUSIBLE_HOST: process.env.NEXT_PUBLIC_PLAUSIBLE_HOST,
    })
  : envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console -- Startup logging before logger is initialized
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console -- Startup logging before logger is initialized
  console.error(JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  throw new Error(
    'Environment validation failed - check configuration above or see .context/environment/overview.md'
  );
}

/**
 * Validated and type-safe environment variables.
 *
 * All required variables are guaranteed to exist and be valid.
 * Use this throughout the application instead of process.env.
 *
 * On the client, only NEXT_PUBLIC_* variables are validated.
 * On the server, all variables are validated.
 *
 * @example
 * ```typescript
 * import { env } from '@/lib/env'
 *
 * // Type-safe access with autocomplete
 * const secret = env.BETTER_AUTH_SECRET // Server-side only
 * const appUrl = env.NEXT_PUBLIC_APP_URL // Available on both
 * ```
 */
export const env = parsed.data as Env;

// Log successful validation in development (server-side only)
if (!isBrowser && env.NODE_ENV === 'development') {
  // eslint-disable-next-line no-console -- Startup logging before logger is initialized
  console.log('✅ Environment variables validated successfully');
}
