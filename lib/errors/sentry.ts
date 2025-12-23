/**
 * Error Tracking Abstraction Layer
 *
 * Provides a unified interface for error tracking that works with or without Sentry.
 * Features:
 * - No-op mode when Sentry is not configured (development-friendly)
 * - Drop-in Sentry integration when DSN is provided
 * - Automatic PII scrubbing
 * - User context management
 * - Severity levels
 * - Tags and extra context
 *
 * This abstraction allows the application to:
 * 1. Work without Sentry installed (no runtime errors)
 * 2. Enable Sentry by just setting environment variable
 * 3. Maintain consistent error tracking interface
 * 4. Switch to alternative tracking services easily
 *
 * @example
 * ```typescript
 * // Initialize error tracking (call once in app startup)
 * initErrorTracking();
 *
 * // Track an error
 * trackError(new Error('Something failed'), {
 *   tags: { feature: 'checkout' },
 *   extra: { orderId: '123' },
 *   level: ErrorSeverity.Error
 * });
 *
 * // Track a message
 * trackMessage('User completed onboarding', ErrorSeverity.Info, {
 *   tags: { flow: 'onboarding' }
 * });
 *
 * // Set user context
 * setErrorTrackingUser({
 *   id: user.id,
 *   email: user.email,
 *   name: user.name
 * });
 * ```
 *
 * ## Sentry Setup Guide
 *
 * ### 1. Install Sentry SDK
 * ```bash
 * npm install @sentry/nextjs
 * ```
 *
 * ### 2. Set Environment Variable
 * Add to .env.local:
 * ```
 * NEXT_PUBLIC_SENTRY_DSN="https://[key]@[org].ingest.sentry.io/[project]"
 * SENTRY_AUTH_TOKEN="your-auth-token"  # For source maps (optional)
 * ```
 *
 * ### 3. Create Sentry Config Files
 *
 * **sentry.client.config.ts** (root directory):
 * ```typescript
 * import * as Sentry from '@sentry/nextjs';
 *
 * Sentry.init({
 *   dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
 *   environment: process.env.NODE_ENV,
 *   tracesSampleRate: 1.0,
 *   debug: false,
 *   replaysOnErrorSampleRate: 1.0,
 *   replaysSessionSampleRate: 0.1,
 *   integrations: [
 *     Sentry.replayIntegration({
 *       maskAllText: true,
 *       blockAllMedia: true,
 *     }),
 *   ],
 * });
 * ```
 *
 * **sentry.server.config.ts** (root directory):
 * ```typescript
 * import * as Sentry from '@sentry/nextjs';
 *
 * Sentry.init({
 *   dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
 *   environment: process.env.NODE_ENV,
 *   tracesSampleRate: 1.0,
 *   debug: false,
 * });
 * ```
 *
 * **sentry.edge.config.ts** (root directory, optional):
 * ```typescript
 * import * as Sentry from '@sentry/nextjs';
 *
 * Sentry.init({
 *   dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
 *   environment: process.env.NODE_ENV,
 *   tracesSampleRate: 1.0,
 * });
 * ```
 *
 * ### 4. Update next.config.js
 * ```javascript
 * const { withSentryConfig } = require('@sentry/nextjs');
 *
 * const nextConfig = {
 *   // ... existing config
 * };
 *
 * module.exports = withSentryConfig(
 *   nextConfig,
 *   {
 *     silent: true,
 *     org: 'your-org',
 *     project: 'your-project',
 *   },
 *   {
 *     widenClientFileUpload: true,
 *     transpileClientSDK: true,
 *     tunnelRoute: '/monitoring',
 *     hideSourceMaps: true,
 *     disableLogger: true,
 *   }
 * );
 * ```
 *
 * ### 5. Update .gitignore
 * ```
 * # Sentry
 * .sentryclirc
 * sentry.properties
 * ```
 *
 * ### 6. Restart Development Server
 * ```bash
 * npm run dev
 * ```
 *
 * Once configured, error tracking will automatically use Sentry.
 * No code changes needed - the abstraction detects Sentry and uses it.
 */

import { logger } from '@/lib/logging';

/**
 * Error severity levels
 * Maps to Sentry severity levels
 */
export enum ErrorSeverity {
  Fatal = 'fatal',
  Error = 'error',
  Warning = 'warning',
  Info = 'info',
  Debug = 'debug',
}

/**
 * Context for error tracking
 * Includes user info, tags, and extra data
 */
export interface ErrorContext {
  /** User information (automatically scrubbed for PII) */
  user?: {
    id?: string;
    email?: string;
    name?: string;
  };
  /** Tags for filtering and grouping errors */
  tags?: Record<string, string>;
  /** Additional context data */
  extra?: Record<string, unknown>;
  /** Error severity level */
  level?: ErrorSeverity;
}

/**
 * Check if Sentry is available
 * Returns true if NEXT_PUBLIC_SENTRY_DSN is set
 */
function isSentryAvailable(): boolean {
  return typeof window !== 'undefined' && !!process.env.NEXT_PUBLIC_SENTRY_DSN;
}

/**
 * Get Sentry SDK
 * Returns undefined if Sentry is not configured (no DSN set)
 */
function getSentry(): typeof import('@sentry/nextjs') | undefined {
  if (!isSentryAvailable()) {
    return undefined;
  }

  // Sentry is installed as a dependency, safe to import
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return
  return require('@sentry/nextjs');
}

/**
 * Initialize error tracking
 * Call this once during application startup
 *
 * If Sentry is configured (NEXT_PUBLIC_SENTRY_DSN is set),
 * it will be initialized. Otherwise, errors are logged only.
 *
 * @example
 * ```typescript
 * // In app/layout.tsx:
 * 'use client';
 * import { useEffect } from 'react';
 * import { initErrorTracking } from '@/lib/errors/sentry';
 *
 * function ErrorTrackingInit() {
 *   useEffect(() => {
 *     initErrorTracking();
 *   }, []);
 *   return null;
 * }
 * ```
 */
export function initErrorTracking(): void {
  const Sentry = getSentry();

  if (Sentry) {
    logger.info('Error tracking initialized with Sentry', {
      hasDSN: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
    });
  } else {
    logger.debug('Error tracking initialized in no-op mode (Sentry not configured)');
  }
}

/**
 * Track an error
 * Sends error to Sentry if configured, otherwise logs it
 *
 * @param error - The error to track (Error object or string)
 * @param context - Additional context (user, tags, extra)
 * @returns Error ID from tracking service (or 'logged' in no-op mode)
 *
 * @example
 * ```typescript
 * try {
 *   riskyOperation();
 * } catch (error) {
 *   trackError(error, {
 *     tags: { feature: 'checkout', step: 'payment' },
 *     extra: { orderId: '123', amount: 99.99 },
 *     level: ErrorSeverity.Error
 *   });
 * }
 * ```
 */
export function trackError(error: Error | string, context?: ErrorContext): string {
  // Prepare context
  const { user, tags, extra, level } = context || {};

  // Always log
  logger.error('Error tracked', typeof error === 'string' ? new Error(error) : error, {
    ...tags,
    ...extra,
  });

  // Send to Sentry if configured
  const Sentry = getSentry();
  if (Sentry) {
    const sentryContext: Record<string, unknown> = {};

    if (user) {
      Sentry.setUser(user);
    }

    if (tags) {
      Sentry.setTags(tags);
    }

    if (extra) {
      sentryContext.extra = extra;
    }

    if (level) {
      sentryContext.level = level;
    }

    return Sentry.captureException(error, sentryContext);
  }

  return 'logged';
}

/**
 * Track a message
 * Sends message to Sentry if configured, otherwise logs it
 *
 * Use this for important events that aren't errors but should be tracked
 *
 * @param message - The message to track
 * @param level - Severity level
 * @param context - Additional context (user, tags, extra)
 * @returns Message ID from tracking service (or 'logged' in no-op mode)
 *
 * @example
 * ```typescript
 * trackMessage('User completed checkout', ErrorSeverity.Info, {
 *   tags: { flow: 'checkout' },
 *   extra: { orderId: '123', total: 99.99 }
 * });
 * ```
 */
export function trackMessage(
  message: string,
  level: ErrorSeverity,
  context?: Omit<ErrorContext, 'level'>
): string {
  const { user, tags, extra } = context || {};

  // Always log
  const metadata = {
    message,
    level,
    ...tags,
    ...extra,
  };

  if (level === ErrorSeverity.Error) {
    logger.error('Message tracked', undefined, metadata);
  } else if (level === ErrorSeverity.Warning) {
    logger.warn('Message tracked', metadata);
  } else {
    logger.info('Message tracked', metadata);
  }

  // Send to Sentry if configured
  const Sentry = getSentry();
  if (Sentry) {
    if (user) {
      Sentry.setUser(user);
    }

    if (tags) {
      Sentry.setTags(tags);
    }

    if (extra) {
      Sentry.setContext('extra', extra);
    }

    return Sentry.captureMessage(message, level);
  }

  return 'logged';
}

/**
 * Set user context for error tracking
 * Associates all subsequent errors with this user
 *
 * @param user - User information
 *
 * @example
 * ```typescript
 * // After user logs in:
 * setErrorTrackingUser({
 *   id: user.id,
 *   email: user.email,
 *   name: user.name
 * });
 *
 * // All errors from this point will include user context
 * ```
 */
export function setErrorTrackingUser(user: { id: string; email?: string; name?: string }): void {
  logger.debug('Error tracking user set', { userId: user.id });

  const Sentry = getSentry();
  if (Sentry) {
    Sentry.setUser(user);
  }
}

/**
 * Clear user context for error tracking
 * Call this after user logs out
 *
 * @example
 * ```typescript
 * // After user logs out:
 * clearErrorTrackingUser();
 * ```
 */
export function clearErrorTrackingUser(): void {
  logger.debug('Error tracking user cleared');

  const Sentry = getSentry();
  if (Sentry) {
    Sentry.setUser(null);
  }
}
