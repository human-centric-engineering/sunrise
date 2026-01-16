/**
 * Monitoring Module
 *
 * Performance measurement and monitoring utilities for Sunrise.
 *
 * Features:
 * - Async/sync operation timing
 * - Database query tracking
 * - Memory usage monitoring
 * - Slow operation detection
 * - Sentry integration for critical alerts
 *
 * @example
 * ```typescript
 * import {
 *   measureAsync,
 *   trackDatabaseQuery,
 *   getMemoryUsage,
 * } from '@/lib/monitoring';
 *
 * // Measure any async operation
 * const { result, metric } = await measureAsync('user-fetch', async () => {
 *   return await fetch('/api/users');
 * });
 *
 * // Track database queries with automatic slow query logging
 * const users = await trackDatabaseQuery('findUsers', () =>
 *   prisma.user.findMany()
 * );
 *
 * // Get memory usage for health checks
 * const memory = getMemoryUsage();
 * ```
 */

// Types
export type {
  PerformanceMetric,
  MeasuredResult,
  MeasureOptions,
  ServiceStatus,
  ServiceHealth,
  MemoryUsage,
  HealthCheckResponse,
} from './types';

// Performance utilities
export {
  measureAsync,
  measureSync,
  trackDatabaseQuery,
  getMemoryUsage,
  formatBytes,
} from './performance';
