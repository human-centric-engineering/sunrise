/**
 * Performance Monitoring Utilities
 *
 * Utilities for measuring operation performance, tracking database queries,
 * and monitoring system resources.
 *
 * Features:
 * - Wrap async/sync operations with automatic timing
 * - Database query tracking with slow query detection
 * - Memory usage monitoring for health checks
 * - Integration with structured logging
 * - Optional Sentry alerting for critical slowdowns
 *
 * @example
 * ```typescript
 * import { measureAsync, trackDatabaseQuery, getMemoryUsage } from '@/lib/monitoring';
 *
 * // Measure any async operation
 * const { result, metric } = await measureAsync('user-fetch', async () => {
 *   return await prisma.user.findMany();
 * });
 *
 * // Track database queries with automatic slow query logging
 * const users = await trackDatabaseQuery('findUsers', () =>
 *   prisma.user.findMany({ where: { active: true } })
 * );
 *
 * // Get formatted memory usage
 * const memory = getMemoryUsage();
 * console.log(`Heap: ${memory.percentage}% used`);
 * ```
 */

import { logger } from '@/lib/logging';
import { trackMessage, ErrorSeverity } from '@/lib/errors/sentry';
import type { PerformanceMetric, MeasuredResult, MeasureOptions, MemoryUsage } from './types';

/**
 * Default threshold for slow operations (ms)
 * Can be overridden via PERF_SLOW_THRESHOLD_MS environment variable
 */
function getSlowThreshold(): number {
  const envValue = process.env.PERF_SLOW_THRESHOLD_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 1000; // Default: 1 second
}

/**
 * Default threshold for critical slowdowns (ms)
 * Can be overridden via PERF_CRITICAL_THRESHOLD_MS environment variable
 */
function getCriticalThreshold(): number {
  const envValue = process.env.PERF_CRITICAL_THRESHOLD_MS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 5000; // Default: 5 seconds
}

/**
 * Measure the performance of an asynchronous operation
 *
 * Wraps an async function with timing instrumentation. Automatically logs
 * slow operations as warnings and reports critical slowdowns to Sentry.
 *
 * @param name - Identifier for the operation being measured
 * @param fn - The async function to measure
 * @param options - Configuration options for measurement
 * @returns The operation result along with performance metrics
 *
 * @example
 * ```typescript
 * const { result, metric } = await measureAsync('fetch-users', async () => {
 *   return await db.users.findMany();
 * });
 *
 * console.log(`Operation took ${metric.duration}ms`);
 * ```
 */
export async function measureAsync<T>(
  name: string,
  fn: () => Promise<T>,
  options: MeasureOptions = {}
): Promise<MeasuredResult<T>> {
  const {
    slowThreshold = getSlowThreshold(),
    criticalThreshold = getCriticalThreshold(),
    metadata = {},
    logMetric = true,
  } = options;

  const startTime = new Date();
  const startMs = performance.now();

  let success = false;
  let error: Error | undefined;
  let result: T;
  let metric: PerformanceMetric;

  try {
    result = await fn();
    success = true;
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    throw e;
  } finally {
    const endMs = performance.now();
    const endTime = new Date();
    const duration = Math.round(endMs - startMs);

    metric = {
      name,
      duration,
      startTime,
      endTime,
      success,
      error,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    if (logMetric) {
      logPerformanceMetric(metric, slowThreshold, criticalThreshold);
    }
  }

  return { result: result!, metric: metric! };
}

/**
 * Measure the performance of a synchronous operation
 *
 * @param name - Identifier for the operation being measured
 * @param fn - The sync function to measure
 * @param options - Configuration options for measurement
 * @returns The operation result along with performance metrics
 *
 * @example
 * ```typescript
 * const { result, metric } = measureSync('compute-hash', () => {
 *   return computeExpensiveHash(data);
 * });
 * ```
 */
export function measureSync<T>(
  name: string,
  fn: () => T,
  options: MeasureOptions = {}
): MeasuredResult<T> {
  const {
    slowThreshold = getSlowThreshold(),
    criticalThreshold = getCriticalThreshold(),
    metadata = {},
    logMetric = true,
  } = options;

  const startTime = new Date();
  const startMs = performance.now();

  let success = false;
  let error: Error | undefined;
  let result: T;
  let metric: PerformanceMetric;

  try {
    result = fn();
    success = true;
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    throw e;
  } finally {
    const endMs = performance.now();
    const endTime = new Date();
    const duration = Math.round(endMs - startMs);

    metric = {
      name,
      duration,
      startTime,
      endTime,
      success,
      error,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };

    if (logMetric) {
      logPerformanceMetric(metric, slowThreshold, criticalThreshold);
    }
  }

  return { result: result!, metric: metric! };
}

/**
 * Track a database query with automatic slow query detection
 *
 * A specialized wrapper for database operations that provides:
 * - Automatic timing of queries
 * - Slow query warnings (default: > 1000ms)
 * - Critical slowdown alerts to Sentry (default: > 5000ms)
 * - Query name included in logs for identification
 *
 * @param queryName - Name/description of the query for logging
 * @param queryFn - The async database query function to execute
 * @returns The query result
 *
 * @example
 * ```typescript
 * // Track a Prisma query
 * const users = await trackDatabaseQuery('findActiveUsers', () =>
 *   prisma.user.findMany({ where: { active: true } })
 * );
 *
 * // With complex query
 * const stats = await trackDatabaseQuery('getUserStats', async () => {
 *   const users = await prisma.user.count();
 *   const active = await prisma.user.count({ where: { active: true } });
 *   return { total: users, active };
 * });
 * ```
 */
export async function trackDatabaseQuery<T>(
  queryName: string,
  queryFn: () => Promise<T>
): Promise<T> {
  const { result } = await measureAsync(`db:${queryName}`, queryFn, {
    metadata: { type: 'database' },
  });
  return result;
}

/**
 * Get current process memory usage
 *
 * Returns formatted memory usage information suitable for health checks
 * and monitoring dashboards.
 *
 * @returns Memory usage information with heap, RSS, and percentage
 *
 * @example
 * ```typescript
 * const memory = getMemoryUsage();
 *
 * console.log(`Heap: ${memory.heapUsed} / ${memory.heapTotal}`);
 * console.log(`Usage: ${memory.percentage}%`);
 * console.log(`RSS: ${memory.rss}`);
 * ```
 */
export function getMemoryUsage(): MemoryUsage {
  const usage = process.memoryUsage();

  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    percentage: Math.round((usage.heapUsed / usage.heapTotal) * 100),
  };
}

/**
 * Format bytes to human-readable string
 *
 * @param bytes - Number of bytes to format
 * @returns Human-readable string (e.g., "52.43 MB")
 *
 * @example
 * ```typescript
 * formatBytes(52428800); // "50.00 MB"
 * formatBytes(1073741824); // "1.00 GB"
 * ```
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

/**
 * Log a performance metric with appropriate level based on duration
 *
 * @internal
 */
function logPerformanceMetric(
  metric: PerformanceMetric,
  slowThreshold: number,
  criticalThreshold: number
): void {
  const { name, duration, success, error, metadata } = metric;

  const logData: Record<string, unknown> = {
    operation: name,
    duration,
    success,
    ...metadata,
  };

  if (error) {
    logData.error = error.message;
  }

  // Critical slowdown - alert to Sentry
  if (duration >= criticalThreshold) {
    logger.error(`Critical slowdown: ${name} took ${duration}ms`, undefined, logData);
    trackMessage(`Critical slowdown detected: ${name} took ${duration}ms`, ErrorSeverity.Error, {
      tags: { type: 'performance', operation: name },
      extra: logData,
    });
    return;
  }

  // Slow operation - warn
  if (duration >= slowThreshold) {
    logger.warn(`Slow operation: ${name} took ${duration}ms`, logData);
    return;
  }

  // Normal operation - debug only
  logger.debug(`Performance: ${name} completed in ${duration}ms`, logData);
}
