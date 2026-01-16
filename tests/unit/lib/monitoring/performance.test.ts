/**
 * Performance Monitoring Tests
 *
 * Tests for the performance monitoring utilities in lib/monitoring/performance.ts
 * - measureAsync: Async operation timing
 * - measureSync: Sync operation timing
 * - trackDatabaseQuery: Database query tracking
 * - getMemoryUsage: Memory usage reporting
 * - formatBytes: Byte formatting utility
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  measureAsync,
  measureSync,
  trackDatabaseQuery,
  getMemoryUsage,
  formatBytes,
} from '@/lib/monitoring';

// Mock dependencies
vi.mock('@/lib/logging', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/errors/sentry', () => ({
  trackMessage: vi.fn(),
  ErrorSeverity: {
    Fatal: 'fatal',
    Error: 'error',
    Warning: 'warning',
    Info: 'info',
    Debug: 'debug',
  },
}));

import { logger } from '@/lib/logging';
import { trackMessage } from '@/lib/errors/sentry';

describe('Performance Monitoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('measureAsync', () => {
    it('should measure async operation and return result with metric', async () => {
      // Arrange
      const expectedResult = { data: 'test' };
      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return expectedResult;
      };

      // Act
      const { result, metric } = await measureAsync('test-operation', asyncFn);

      // Assert
      expect(result).toEqual(expectedResult);
      expect(metric.name).toBe('test-operation');
      expect(metric.success).toBe(true);
      expect(metric.duration).toBeGreaterThanOrEqual(0);
      expect(metric.startTime).toBeInstanceOf(Date);
      expect(metric.endTime).toBeInstanceOf(Date);
    });

    it('should propagate errors from async operation', async () => {
      // Arrange
      const error = new Error('Test error');
      const asyncFn = async () => {
        throw error;
      };

      // Act & Assert
      await expect(measureAsync('failing-operation', asyncFn)).rejects.toThrow('Test error');
    });

    it('should log debug message for fast operations', async () => {
      // Arrange
      const asyncFn = async () => 'fast result';

      // Act
      await measureAsync('fast-operation', asyncFn);

      // Assert
      expect(vi.mocked(logger.debug)).toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });

    it('should log warning for slow operations', async () => {
      // Arrange
      vi.stubEnv('PERF_SLOW_THRESHOLD_MS', '1');
      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'slow result';
      };

      // Act
      await measureAsync('slow-operation', asyncFn);

      // Assert
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    });

    it('should alert Sentry for critical slowdowns', async () => {
      // Arrange
      vi.stubEnv('PERF_SLOW_THRESHOLD_MS', '1');
      vi.stubEnv('PERF_CRITICAL_THRESHOLD_MS', '5');
      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return 'critical result';
      };

      // Act
      await measureAsync('critical-operation', asyncFn);

      // Assert
      expect(vi.mocked(trackMessage)).toHaveBeenCalled();
      expect(vi.mocked(logger.error)).toHaveBeenCalled();
    });

    it('should respect custom thresholds in options', async () => {
      // Arrange
      const asyncFn = async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'result';
      };

      // Act
      await measureAsync('custom-threshold', asyncFn, {
        slowThreshold: 1,
        criticalThreshold: 100,
      });

      // Assert
      expect(vi.mocked(logger.warn)).toHaveBeenCalled();
    });

    it('should include metadata in metric when provided', async () => {
      // Arrange
      const asyncFn = async () => 'result';
      const metadata = { userId: '123', action: 'fetch' };

      // Act
      const { metric } = await measureAsync('metadata-test', asyncFn, {
        metadata,
      });

      // Assert
      expect(metric.metadata).toEqual(metadata);
    });

    it('should not log when logMetric is false', async () => {
      // Arrange
      const asyncFn = async () => 'result';

      // Act
      await measureAsync('no-log-test', asyncFn, { logMetric: false });

      // Assert
      expect(vi.mocked(logger.debug)).not.toHaveBeenCalled();
    });
  });

  describe('measureSync', () => {
    it('should measure sync operation and return result with metric', () => {
      // Arrange
      const expectedResult = 42;
      const syncFn = () => {
        let _sum = 0;
        for (let i = 0; i < 1000; i++) {
          _sum += i;
        }
        return expectedResult;
      };

      // Act
      const { result, metric } = measureSync('sync-operation', syncFn);

      // Assert
      expect(result).toBe(expectedResult);
      expect(metric.name).toBe('sync-operation');
      expect(metric.success).toBe(true);
      expect(metric.duration).toBeGreaterThanOrEqual(0);
    });

    it('should propagate errors from sync operation', () => {
      // Arrange
      const error = new Error('Sync error');
      const syncFn = () => {
        throw error;
      };

      // Act & Assert
      expect(() => measureSync('failing-sync', syncFn)).toThrow('Sync error');
    });

    it('should log debug message for fast sync operations', () => {
      // Arrange
      const syncFn = () => 'fast';

      // Act
      measureSync('fast-sync', syncFn);

      // Assert
      expect(vi.mocked(logger.debug)).toHaveBeenCalled();
    });
  });

  describe('trackDatabaseQuery', () => {
    it('should track database query and return result', async () => {
      // Arrange
      const expectedUsers = [{ id: '1', name: 'Alice' }];
      const queryFn = async () => expectedUsers;

      // Act
      const result = await trackDatabaseQuery('findUsers', queryFn);

      // Assert
      expect(result).toEqual(expectedUsers);
    });

    it('should prefix query name with db:', async () => {
      // Arrange
      const queryFn = async () => [];

      // Act
      await trackDatabaseQuery('testQuery', queryFn);

      // Assert
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        expect.stringContaining('db:testQuery'),
        expect.any(Object)
      );
    });

    it('should include database type in metadata', async () => {
      // Arrange
      const queryFn = async () => ({ count: 10 });

      // Act
      await trackDatabaseQuery('countUsers', queryFn);

      // Assert
      expect(vi.mocked(logger.debug)).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'database' })
      );
    });

    it('should propagate database errors', async () => {
      // Arrange
      const queryFn = async () => {
        throw new Error('Database connection failed');
      };

      // Act & Assert
      await expect(trackDatabaseQuery('failingQuery', queryFn)).rejects.toThrow(
        'Database connection failed'
      );
    });
  });

  describe('getMemoryUsage', () => {
    it('should return memory usage with all required fields', () => {
      // Act
      const memory = getMemoryUsage();

      // Assert
      expect(memory).toHaveProperty('heapUsed');
      expect(memory).toHaveProperty('heapTotal');
      expect(memory).toHaveProperty('rss');
      expect(memory).toHaveProperty('percentage');
    });

    it('should return numeric values', () => {
      // Act
      const memory = getMemoryUsage();

      // Assert
      expect(typeof memory.heapUsed).toBe('number');
      expect(typeof memory.heapTotal).toBe('number');
      expect(typeof memory.rss).toBe('number');
      expect(typeof memory.percentage).toBe('number');
    });

    it('should return percentage between 0 and 100', () => {
      // Act
      const memory = getMemoryUsage();

      // Assert
      expect(memory.percentage).toBeGreaterThanOrEqual(0);
      expect(memory.percentage).toBeLessThanOrEqual(100);
    });

    it('should return positive values', () => {
      // Act
      const memory = getMemoryUsage();

      // Assert
      expect(memory.heapUsed).toBeGreaterThan(0);
      expect(memory.heapTotal).toBeGreaterThan(0);
      expect(memory.rss).toBeGreaterThan(0);
    });
  });

  describe('formatBytes', () => {
    it('should format 0 bytes', () => {
      expect(formatBytes(0)).toBe('0 Bytes');
    });

    it('should format bytes', () => {
      expect(formatBytes(500)).toBe('500 Bytes');
    });

    it('should format kilobytes', () => {
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(52428800)).toBe('50 MB');
    });

    it('should format gigabytes', () => {
      expect(formatBytes(1073741824)).toBe('1 GB');
    });

    it('should format with 2 decimal places', () => {
      expect(formatBytes(1234567)).toBe('1.18 MB');
    });
  });

  describe('Environment Variable Thresholds', () => {
    it('should use default slow threshold of 1000ms', async () => {
      // Arrange: No env var set
      const asyncFn = async () => 'result';

      // Act
      await measureAsync('test', asyncFn);

      // Assert: Default threshold is 1000ms, fast operation should log debug
      expect(vi.mocked(logger.debug)).toHaveBeenCalled();
    });

    it('should use default critical threshold of 5000ms', async () => {
      // Arrange: No env var set
      const asyncFn = async () => 'result';

      // Act
      await measureAsync('test', asyncFn);

      // Assert: Fast operation should not trigger critical alert
      expect(vi.mocked(trackMessage)).not.toHaveBeenCalled();
    });

    it('should handle invalid threshold env vars gracefully', async () => {
      // Arrange
      vi.stubEnv('PERF_SLOW_THRESHOLD_MS', 'invalid');
      vi.stubEnv('PERF_CRITICAL_THRESHOLD_MS', 'notanumber');
      const asyncFn = async () => 'result';

      // Act & Assert: Should not throw, uses defaults
      await expect(measureAsync('test', asyncFn)).resolves.toBeDefined();
    });

    it('should handle negative threshold env vars by using defaults', async () => {
      // Arrange
      vi.stubEnv('PERF_SLOW_THRESHOLD_MS', '-100');
      const asyncFn = async () => 'result';

      // Act & Assert: Should not throw, uses defaults
      await expect(measureAsync('test', asyncFn)).resolves.toBeDefined();
    });
  });
});
