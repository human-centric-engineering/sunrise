/**
 * Global Client-Side Error Handler
 *
 * Provides centralized error handling for unhandled client-side errors:
 * - Catches unhandled promise rejections
 * - Catches uncaught runtime errors
 * - Normalizes errors to consistent format
 * - Logs errors with structured logger
 * - Integrates with error tracking service
 *
 * Features:
 * - Automatic error normalization (unknown → Error)
 * - PII scrubbing before tracking
 * - Prevents infinite error loops
 * - Browser-only execution (no SSR)
 *
 * @example
 * ```typescript
 * // In app/layout.tsx:
 * 'use client';
 * import { initGlobalErrorHandler } from '@/lib/errors/handler';
 * import { useEffect } from 'react';
 *
 * function ErrorHandlingInit() {
 *   useEffect(() => {
 *     initGlobalErrorHandler();
 *   }, []);
 *   return null;
 * }
 * ```
 */

import { isRecord } from '@/lib/utils';
import { logger } from '@/lib/logging';
import { loggablePath, scrubUrlsDeep, scrubUrlsInError } from '@/lib/logging/redact-path';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

/** The flag `@sentry/core` sets on an exception it has captured (`checkOrSetAlreadyCaught`). */
const SENTRY_CAPTURED_MARKER = '__sentry_captured__';

/**
 * Fields that contain sensitive data
 * These will be scrubbed before sending to error tracking
 */
const SENSITIVE_FIELDS = [
  'password',
  'token',
  'apiKey',
  'secret',
  'creditCard',
  'ssn',
  'authorization',
  'sessionToken',
  'refreshToken',
  'accessToken',
];

/**
 * Track processed errors to prevent infinite loops
 * Clear periodically to prevent memory leaks
 */
const processedErrors = new Set<string>();
const MAX_PROCESSED_ERRORS = 100;

/**
 * Normalize an unknown error value to a consistent format
 * Extracts message, error object, and metadata
 *
 * @param error - The error value to normalize (can be anything)
 * @returns Normalized error information
 *
 * @example
 * ```typescript
 * const normalized = normalizeError(new Error('Something failed'));
 * // { message: 'Something failed', error: Error, metadata: {} }
 *
 * const normalized = normalizeError('String error');
 * // { message: 'String error', error: Error('String error'), metadata: {} }
 *
 * const normalized = normalizeError({ code: 'ERR_001', details: '...' });
 * // { message: 'Unknown error', error: Error('Unknown error'), metadata: { code: 'ERR_001', details: '...' } }
 * ```
 */
export function normalizeError(error: unknown): {
  message: string;
  error: Error;
  metadata: Record<string, unknown>;
} {
  // Case 1: Already an Error object
  if (error instanceof Error) {
    return {
      message: error.message,
      error,
      metadata: {
        name: error.name,
        stack: error.stack,
        // Include any additional properties (e.g., Prisma error codes)
        ...Object.fromEntries(
          Object.entries(error).filter(([key]) => !['message', 'name', 'stack'].includes(key))
        ),
      },
    };
  }

  // Case 2: String error
  if (typeof error === 'string') {
    return {
      message: error,
      error: new Error(error),
      metadata: {},
    };
  }

  // Case 3: Object with message property
  if (isRecord(error) && typeof error.message === 'string') {
    return {
      message: error.message,
      error: new Error(error.message),
      metadata: error,
    };
  }

  // Case 4: Other objects (extract useful info)
  if (isRecord(error)) {
    return {
      message: 'Unknown error occurred',
      error: new Error('Unknown error occurred'),
      metadata: error,
    };
  }

  // Case 5: Primitives and other types
  return {
    message: String(error),
    error: new Error(String(error)),
    metadata: { originalValue: error },
  };
}

/**
 * Scrub sensitive data from an object before sending to error tracking
 * Recursively replaces sensitive field values with '[REDACTED]'
 *
 * @param obj - The object to scrub
 * @returns Scrubbed copy of the object
 */
function scrubSensitiveData(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => scrubSensitiveData(item));
  }

  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_FIELDS.some((field) => lowerKey.includes(field.toLowerCase()));

    if (isSensitive) {
      scrubbed[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      scrubbed[key] = scrubSensitiveData(value);
    } else {
      scrubbed[key] = value;
    }
  }

  return scrubbed;
}

/**
 * Generate a unique error fingerprint for deduplication
 * Uses error message and stack trace
 */
function getErrorFingerprint(error: Error): string {
  const message = error.message || 'unknown';
  const stack = error.stack || 'no-stack';
  const firstStackLine = stack.split('\n')[1] || 'no-line';
  return `${message}:${firstStackLine}`;
}

/**
 * Handle a client-side error
 * Logs the error and sends it to error tracking
 *
 * @param error - The error to handle
 * @param context - Additional context for the error
 *
 * @example
 * ```typescript
 * try {
 *   riskyOperation();
 * } catch (error) {
 *   handleClientError(error, {
 *     component: 'UserProfile',
 *     action: 'delete-account',
 *     userId: user.id
 *   });
 * }
 * ```
 */
export function handleClientError(error: unknown, context: Record<string, unknown> = {}): void {
  const normalized = normalizeError(error);
  const fingerprint = getErrorFingerprint(normalized.error);

  // Prevent infinite loops - skip if we've already processed this error
  if (processedErrors.has(fingerprint)) {
    return;
  }

  // Track this error
  processedErrors.add(fingerprint);

  // Clean up old errors to prevent memory leaks
  if (processedErrors.size > MAX_PROCESSED_ERRORS) {
    const firstKey = processedErrors.values().next().value;
    if (firstKey) {
      processedErrors.delete(firstKey);
    }
  }

  // Scrub sensitive data from context and metadata, then every URL in them:
  // an error from an inline script reports the page URL as its file, in
  // `filename` and in the stack's frames, and a caller's context can carry one
  // at any depth (#952).
  const rawScrubbedContext = scrubUrlsDeep(scrubSensitiveData(context));
  const scrubbedContext = isRecord(rawScrubbedContext) ? rawScrubbedContext : {};
  const rawScrubbedMetadata = scrubUrlsDeep(scrubSensitiveData(normalized.metadata));
  const scrubbedMetadata = isRecord(rawScrubbedMetadata) ? rawScrubbedMetadata : {};
  // The Error itself goes to the logger and to Sentry with its stack, so they
  // get a copy with the same URLs scrubbed.
  const reportedError = scrubUrlsInError(normalized.error);

  // The page path, never `location.href`: the query and fragment can carry a
  // token or an email, and a path segment can be a credential (#952). The
  // scrubbers above match key names, so they cannot clean a URL value.
  const path = loggablePath(typeof window !== 'undefined' ? window.location.pathname : undefined);

  // Log the error with structured logger
  logger.error('Unhandled client error', reportedError, {
    ...scrubbedContext,
    ...scrubbedMetadata,
    errorType: 'unhandled',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    path,
  });

  // Send to error tracking service
  trackError(reportedError, {
    tags: {
      errorType: 'unhandled',
      source: 'globalHandler',
    },
    extra: {
      ...scrubbedContext,
      ...scrubbedMetadata,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      path,
    },
    level: ErrorSeverity.Error,
  });

  // Sentry marks an error it has captured, so its own global handlers skip it
  // later; it marked the copy, so mark the original too.
  if (Reflect.get(reportedError, SENTRY_CAPTURED_MARKER) === true) {
    try {
      Object.defineProperty(normalized.error, SENTRY_CAPTURED_MARKER, {
        value: true,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    } catch {
      // A frozen error cannot be marked; Sentry's dedupe is the fallback.
    }
  }
}

/**
 * Initialize global error handlers
 * Sets up listeners for unhandled errors and promise rejections
 *
 * IMPORTANT: Only call this in client-side code (browser only)
 *
 * @example
 * ```typescript
 * // In app/layout.tsx:
 * 'use client';
 * import { useEffect } from 'react';
 * import { initGlobalErrorHandler } from '@/lib/errors/handler';
 *
 * function ErrorHandlingInit() {
 *   useEffect(() => {
 *     return initGlobalErrorHandler();
 *   }, []);
 *   return null;
 * }
 * ```
 */
export function initGlobalErrorHandler(): (() => void) | undefined {
  // Only run in browser
  if (typeof window === 'undefined') {
    return;
  }

  // Prevent double initialization
  if ((window as { __errorHandlerInitialized?: boolean }).__errorHandlerInitialized) {
    return;
  }
  (window as { __errorHandlerInitialized?: boolean }).__errorHandlerInitialized = true;

  // Handle unhandled promise rejections
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    handleClientError(event.reason, {
      errorType: 'unhandledRejection',
    });
  };

  // Handle uncaught runtime errors
  const onError = (event: ErrorEvent): void => {
    handleClientError(event.error || event.message, {
      errorType: 'uncaughtError',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  };

  window.addEventListener('unhandledrejection', onUnhandledRejection);
  window.addEventListener('error', onError);

  logger.debug('Global error handler initialized');

  // Return cleanup function for HMR and useEffect teardown
  return (): void => {
    window.removeEventListener('unhandledrejection', onUnhandledRejection);
    window.removeEventListener('error', onError);
    (window as { __errorHandlerInitialized?: boolean }).__errorHandlerInitialized = false;
  };
}
