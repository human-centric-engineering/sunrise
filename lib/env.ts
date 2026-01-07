import { z } from 'zod';

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

  // Authentication (better-auth)
  BETTER_AUTH_URL: z.string().url({
    message:
      'BETTER_AUTH_URL must be a valid URL (e.g., http://localhost:3000 for local development)',
  }),
  BETTER_AUTH_SECRET: z.string().min(32, {
    message:
      'BETTER_AUTH_SECRET must be at least 32 characters. Generate with: openssl rand -base64 32',
  }),

  // OAuth Providers (optional)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Email (optional for Phase 1, required in Phase 3)
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),
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

  // Logging Configuration (optional)
  LOG_LEVEL: z
    .enum(['debug', 'info', 'warn', 'error'])
    .optional()
    .describe('Logging verbosity level. Defaults to "debug" in development, "info" in production'),
});

// Client-side environment variables (NEXT_PUBLIC_* vars)
const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().url({
    message:
      'NEXT_PUBLIC_APP_URL must be a valid URL (embedded at build time, must match BETTER_AUTH_URL for consistency)',
  }),
});

// Combined schema for type inference
const envSchema = serverEnvSchema.merge(clientEnvSchema);

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
    })
  : envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
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
  console.log('✅ Environment variables validated successfully');
}
