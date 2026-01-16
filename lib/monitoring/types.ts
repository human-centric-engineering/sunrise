/**
 * Performance Monitoring Types
 *
 * TypeScript interfaces for performance measurement and monitoring.
 */

/**
 * Individual performance measurement result
 */
export interface PerformanceMetric {
  /** Name/identifier of the operation being measured */
  name: string;
  /** Duration in milliseconds */
  duration: number;
  /** Timestamp when measurement started */
  startTime: Date;
  /** Timestamp when measurement ended */
  endTime: Date;
  /** Whether the operation succeeded */
  success: boolean;
  /** Optional error if operation failed */
  error?: Error;
  /** Optional metadata about the operation */
  metadata?: Record<string, unknown>;
}

/**
 * Result of a measured async operation
 */
export interface MeasuredResult<T> {
  /** The result of the operation */
  result: T;
  /** Performance metrics for the operation */
  metric: PerformanceMetric;
}

/**
 * Options for performance measurement
 */
export interface MeasureOptions {
  /** Threshold in ms above which to log a warning (defaults to PERF_SLOW_THRESHOLD_MS or 1000) */
  slowThreshold?: number;
  /** Threshold in ms above which to report to Sentry (defaults to PERF_CRITICAL_THRESHOLD_MS or 5000) */
  criticalThreshold?: number;
  /** Additional metadata to include in the metric */
  metadata?: Record<string, unknown>;
  /** Whether to log the metric (defaults to true) */
  logMetric?: boolean;
}

/**
 * Service health status for health checks
 */
export type ServiceStatus = 'operational' | 'degraded' | 'outage';

/**
 * Individual service health information
 */
export interface ServiceHealth {
  /** Current status of the service */
  status: ServiceStatus;
  /** Whether the service is connected/reachable */
  connected: boolean;
  /** Response latency in milliseconds */
  latency?: number;
  /** Optional error message if service is unhealthy */
  error?: string;
}

/**
 * Memory usage information
 */
export interface MemoryUsage {
  /** Heap memory used in bytes */
  heapUsed: number;
  /** Total heap memory in bytes */
  heapTotal: number;
  /** Resident Set Size in bytes */
  rss: number;
  /** Percentage of heap used (0-100) */
  percentage: number;
}

/**
 * Enhanced health check response structure
 */
export interface HealthCheckResponse {
  /** Overall health status */
  status: 'ok' | 'error';
  /** Application version from package.json */
  version: string;
  /** Process uptime in seconds */
  uptime: number;
  /** Timestamp of the health check */
  timestamp: string;
  /** Health of individual services */
  services: {
    database: ServiceHealth;
  };
  /** Optional memory usage (controlled by HEALTH_INCLUDE_MEMORY) */
  memory?: MemoryUsage;
  /** Optional error message for exception scenarios */
  error?: string;
}
