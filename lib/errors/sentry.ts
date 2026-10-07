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

import type { Breadcrumb, Event, init as sentryInit } from '@sentry/nextjs';
import { logger } from '@/lib/logging';
import { scrubUrl, scrubUrlsDeep, scrubUrlsInText } from '@/lib/logging/redact-path';

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

  const Sentry = loadSentry();
  registerUrlScrubber(Sentry);
  return Sentry;
}

function loadSentry(): typeof import('@sentry/nextjs') {
  // Sentry is installed as a dependency, safe to import
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-return
  return require('@sentry/nextjs');
}

/**
 * Marks Sentry's global scope as already carrying the scrubber. On
 * `globalThis`, not a module variable, because the global scope is
 * process-wide while this module can be evaluated more than once (dev HMR, a
 * second server bundle).
 */
const URL_SCRUBBER_REGISTERED = Symbol.for('sunrise.sentry.urlScrubberRegistered');

/**
 * Register `scrubSentryEvent` on Sentry's global scope, once per process, so
 * every error and transaction event (and the breadcrumbs it carries) is
 * scrubbed of page URLs without each fork wiring `beforeSend` (#952). The
 * global scope, not `Sentry.addEventProcessor`, which on the server attaches
 * to the current request's isolation scope only.
 */
function registerUrlScrubber(Sentry: typeof import('@sentry/nextjs')): void {
  if (Reflect.get(globalThis, URL_SCRUBBER_REGISTERED) === true) return;
  Sentry.getGlobalScope().addEventProcessor(scrubSentryEvent);
  Reflect.set(globalThis, URL_SCRUBBER_REGISTERED, true);
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
  // Register the page-URL scrubber whether or not NEXT_PUBLIC_SENTRY_DSN is
  // set: a fork may init Sentry with a DSN written into its config, and a
  // processor on an uninitialised SDK does nothing (#952).
  registerUrlScrubber(loadSentry());
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

/** The span `beforeSendSpan` receives (`@sentry/nextjs` does not re-export the type). */
type StreamedSpanJSON = Parameters<
  NonNullable<NonNullable<Parameters<typeof sentryInit>[0]>['beforeSendSpan']>
>[0];

/**
 * Span attributes and breadcrumb data dropped outright: the query string, the
 * fragment, and the raw value of each dynamic path segment
 * (`url.path.parameter.<key>`, `url.path.params.<key>`, `params.<key>`).
 */
const DROPPED_ATTRIBUTE =
  /^(?:url\.query|url\.fragment|http\.query|http\.fragment|url\.path\.parameters?\..*|url\.path\.params\..*|params\..*)$/;

/**
 * Scrub a record in place: every URL and path in every value — a rule, not a
 * list of keys, so `url.full`, `http.url`, `next.span_name`, a `referer`
 * header and nested objects are all covered — and query, fragment and
 * path-parameter keys dropped.
 */
function scrubRecord(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (DROPPED_ATTRIBUTE.test(key)) delete record[key];
    else record[key] = scrubUrlsDeep(record[key]);
  }
}

/**
 * Scrub every URL and path in a breadcrumb's message and data (a fetch or xhr
 * `url`, a navigation's `from` / `to`, a console breadcrumb's arguments) and
 * drop `url.query` / `url.fragment`. `scrubSentryEvent` runs it on the
 * breadcrumbs an event carries, so it need not also be set as
 * `beforeBreadcrumb`. Returns a copy: a fetch breadcrumb's `data` is the SDK's
 * own request object, shared with its other fetch handlers.
 */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  const scrubbed = { ...breadcrumb };
  if (scrubbed.message !== undefined) scrubbed.message = scrubUrlsInText(scrubbed.message);
  if (scrubbed.data) {
    const data: Record<string, unknown> = { ...scrubbed.data };
    scrubRecord(data);
    scrubbed.data = data;
  }
  return scrubbed;
}

/**
 * `beforeSendSpan` for `Sentry.init`: scrubs the URLs, paths and dynamic
 * path-segment values a span records in its name and attributes. With the
 * v11 default `traceLifecycle: 'stream'` this is the only hook transactions
 * and spans pass through; `beforeSendTransaction` is not called.
 *
 * @example
 * Sentry.init({ beforeSendSpan: scrubSentrySpan, ... });
 */
export function scrubSentrySpan(span: StreamedSpanJSON): StreamedSpanJSON {
  const attributes = { ...span.attributes };
  scrubRecord(attributes);
  const links = span.links?.map((link) => {
    if (!link.attributes) return link;
    const linkAttributes = { ...link.attributes };
    scrubRecord(linkAttributes);
    return { ...link, attributes: linkAttributes };
  });
  return { ...span, name: scrubUrlsInText(span.name), attributes, ...(links && { links }) };
}

/**
 * `beforeSend` for `Sentry.init`: scrubs the page URL the SDK records on an
 * error event, its query string, the transaction name, the message and
 * exception values, the stack frames' file URLs (an inline script's frame is
 * the page URL), every string in `extra` (nested objects included), the
 * trace context's span data and the attached breadcrumbs. Sunrise registers
 * it on Sentry's global scope (see `registerUrlScrubber`), so it also runs on
 * transactions under `traceLifecycle: 'static'`, scrubbing each child span.
 * Pass it as `beforeSend` too where Sunrise's code may not have run first:
 * `instrumentation-client.ts` (the client registers after hydration) and
 * `sentry.edge.config.ts`.
 *
 * `dataCollection.urlQueryParams: false` drops query strings, but not the
 * fragment or a credential in the path (a `/s/<token>` share page), and only
 * for URLs the SDK collected itself (#952).
 *
 * @example
 * Sentry.init({ beforeSend: scrubSentryEvent, ... }); // client and edge
 */
export function scrubSentryEvent<T extends Event>(event: T): T {
  if (event.request) {
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    delete event.request.query_string;
    // A Referer, if a fork widens `dataCollection.httpHeaders`.
    if (event.request.headers) scrubRecord(event.request.headers);
  }
  if (event.logentry) {
    if (event.logentry.message) event.logentry.message = scrubUrlsInText(event.logentry.message);
    if (event.logentry.params)
      event.logentry.params = event.logentry.params.map((param) => scrubUrlsDeep(param));
  }
  if (event.transaction) event.transaction = scrubUrlsInText(event.transaction);
  if (typeof event.message === 'string') event.message = scrubUrlsInText(event.message);
  if (event.extra) scrubRecord(event.extra);
  event.exception?.values?.forEach((exception) => {
    if (exception.value) exception.value = scrubUrlsInText(exception.value);
    exception.stacktrace?.frames?.forEach((frame) => {
      if (frame.filename) frame.filename = scrubUrl(frame.filename);
      if (frame.abs_path) frame.abs_path = scrubUrl(frame.abs_path);
    });
  });
  const trace = event.contexts?.trace;
  // Copies: under `traceLifecycle: 'static'` these are the live spans' own
  // attribute objects.
  if (trace?.data) {
    const data = { ...trace.data };
    scrubRecord(data);
    trace.data = data;
  }
  event.spans?.forEach((span) => {
    if (span.description) span.description = scrubUrlsInText(span.description);
    // Typed as always present; a span another processor built may lack it.
    if (span.data) {
      const data = { ...span.data };
      scrubRecord(data);
      span.data = data;
    }
  });
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubSentryBreadcrumb);
  return event;
}
