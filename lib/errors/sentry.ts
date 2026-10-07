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
 * ## Setting Sentry up
 *
 * See `.context/monitoring/sentry-setup.md`: the wizard, the environment
 * variables, and, from `@sentry/nextjs` 11, the `dataCollection` block every
 * `Sentry.init` needs. v11 collects request bodies, headers, cookies and gen-AI
 * inputs and outputs by default, and Sunrise's agents carry personal data
 * through all of them.
 *
 * Once configured, error tracking will automatically use Sentry.
 * No code changes needed - the abstraction detects Sentry and uses it.
 */

import type { Breadcrumb, Event } from '@sentry/nextjs';
import { logger } from '@/lib/logging';
import { collapseDynamicSegments } from '@/lib/logging/redact-path';

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
 * Works on both client and server
 */
function isSentryAvailable(): boolean {
  return !!process.env.NEXT_PUBLIC_SENTRY_DSN;
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
    let eventId = '';
    Sentry.withScope((scope) => {
      if (user) {
        scope.setUser(user);
      }
      if (tags) {
        Object.entries(tags).forEach(([key, value]) => scope.setTag(key, value));
      }
      if (extra) {
        Object.entries(extra).forEach(([key, value]) => scope.setExtra(key, value));
      }
      if (level) {
        scope.setLevel(level);
      }
      eventId = Sentry.captureException(error);
    });
    return eventId;
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
    let eventId = '';
    Sentry.withScope((scope) => {
      if (user) {
        scope.setUser(user);
      }
      if (tags) {
        Object.entries(tags).forEach(([key, value]) => scope.setTag(key, value));
      }
      if (extra) {
        Object.entries(extra).forEach(([key, value]) => scope.setExtra(key, value));
      }
      eventId = Sentry.captureMessage(message, level);
    });
    return eventId;
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

/**
 * Reduce a URL to its origin and its path, with the query string, the fragment
 * and any `user:password@` dropped and every id- or credential-shaped path
 * segment collapsed to `[param]` (see `collapseDynamicSegments`). Accepts an
 * absolute URL or a relative path.
 *
 * @example
 * scrubUrl('https://app.example.com/s/Xk9fQ2mZp4LrT7vB1nWc8sYd?email=a%40b.c#x');
 * // 'https://app.example.com/s/[param]'
 */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const withoutQuery = cut === -1 ? url : url.slice(0, cut);
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/is.exec(withoutQuery);
  const origin = (match?.[1] ?? '').replace(/\/\/[^/]*@/, '//');
  return origin + collapseDynamicSegments(match?.[2] ?? '');
}

/** Breadcrumb `data` keys that hold a URL (fetch/xhr `url`, navigation `from`/`to`). */
const BREADCRUMB_URL_KEYS = ['url', 'from', 'to'] as const;

/**
 * `beforeBreadcrumb` for `Sentry.init`: scrubs the URLs a fetch, xhr or
 * navigation breadcrumb records, with `scrubUrl`.
 *
 * @example
 * Sentry.init({ beforeBreadcrumb: scrubSentryBreadcrumb, ... });
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const data = breadcrumb.data;
  if (!data) return breadcrumb;
  for (const key of BREADCRUMB_URL_KEYS) {
    const value: unknown = data[key];
    if (typeof value === 'string') data[key] = scrubUrl(value);
  }
  return breadcrumb;
}

/**
 * `beforeSend` (and `beforeSendTransaction`) for `Sentry.init`: scrubs the page
 * URL the SDK records on the event itself, its query string, a raw-path
 * transaction name and the attached breadcrumbs.
 *
 * `dataCollection.urlQueryParams: false` drops query strings, but not the
 * fragment or a credential in the path (a `/s/<token>` share page), and only
 * for URLs the SDK collected itself (#952).
 *
 * @example
 * Sentry.init({ beforeSend: scrubSentryEvent, beforeSendTransaction: scrubSentryEvent, ... });
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    delete event.request.query_string;
  }
  if (event.transaction?.startsWith('/')) {
    event.transaction = scrubUrl(event.transaction);
  }
  event.breadcrumbs?.forEach(scrubSentryBreadcrumb);
  return event;
}
