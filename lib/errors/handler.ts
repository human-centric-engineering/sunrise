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

import { logger } from '@/lib/logging';

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
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return {
      message: error.message,
      error: new Error(error.message),
      metadata: error as Record<string, unknown>,
    };
  }

  // Case 4: Other objects (extract useful info)
  if (error && typeof error === 'object') {
    const metadata = error as Record<string, unknown>;
    return {
      message: 'Unknown error occurred',
      error: new Error('Unknown error occurred'),
      metadata,
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

  // Scrub sensitive data from context and metadata
  const scrubbedContext = scrubSensitiveData(context) as Record<string, unknown>;
  const scrubbedMetadata = scrubSensitiveData(normalized.metadata) as Record<string, unknown>;

  // Log the error with structured logger
  logger.error('Unhandled client error', normalized.error, {
    ...scrubbedContext,
    ...scrubbedMetadata,
    errorType: 'unhandled',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    url: typeof window !== 'undefined' ? window.location.href : undefined,
  });

  // TODO: Send to error tracking service (implemented in Day 4)
  // trackError(normalized.error, {
  //   tags: { errorType: 'unhandled' },
  //   extra: { ...scrubbedContext, ...scrubbedMetadata }
  // });
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
 *     initGlobalErrorHandler();
 *   }, []);
 *   return null;
 * }
 * ```
 */
export function initGlobalErrorHandler(): void {
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
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    event.preventDefault(); // Prevent default browser error logging

    handleClientError(event.reason, {
      errorType: 'unhandledRejection',
      promise: event.promise,
    });
  });

  // Handle uncaught runtime errors
  window.addEventListener('error', (event: ErrorEvent) => {
    event.preventDefault(); // Prevent default browser error logging

    handleClientError(event.error || event.message, {
      errorType: 'uncaughtError',
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  logger.debug('Global error handler initialized');
}
