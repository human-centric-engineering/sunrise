/**
 * Integration Test: Health Check API Endpoint
 *
 * Tests for the enhanced health check endpoint with:
 * - Version, uptime, and timestamp fields
 * - Services structure with status indicators
 * - Optional memory usage reporting
 * - Database connectivity checks
 *
 * @see app/api/health/route.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '@/app/api/health/route';

/**
 * Mock dependencies
 */

// Mock database utilities
vi.mock('@/lib/db/utils', () => ({
  getDatabaseHealth: vi.fn(),
}));

// Mock logger to verify error logging
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock monitoring utilities
vi.mock('@/lib/monitoring', () => ({
  getMemoryUsage: vi.fn(() => ({
    heapUsed: 52428800,
    heapTotal: 104857600,
    rss: 157286400,
    percentage: 50,
  })),
}));

// Import mocked modules
import { getDatabaseHealth } from '@/lib/db/utils';
import { logger } from '@/lib/logging';
import { getMemoryUsage } from '@/lib/monitoring';

/**
 * Helper function to parse JSON response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Response type interface
 */
interface HealthResponse {
  status: 'ok' | 'error';
  version: string;
  uptime: number;
  timestamp: string;
  services: {
    database: {
      status: 'operational' | 'degraded' | 'outage';
      connected: boolean;
      latency?: number;
    };
  };
  memory?: {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    percentage: number;
  };
  error?: string;
}

/**
 * Test Suite: GET /api/health
 */
describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Success Scenarios
   */
  describe('Success scenarios', () => {
    it('should return 200 and ok status when database is connected', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.services.database.connected).toBe(true);
      expect(body.services.database.status).toBe('operational');
      expect(body.services.database.latency).toBe(5);
    });

    it('should include version field', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body).toHaveProperty('version');
      expect(typeof body.version).toBe('string');
    });

    it('should include uptime field as number', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body).toHaveProperty('uptime');
      expect(typeof body.uptime).toBe('number');
      expect(body.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should include timestamp in ISO format', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body.timestamp).toBeDefined();
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('should not include memory by default', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body.memory).toBeUndefined();
    });

    it('should include memory when HEALTH_INCLUDE_MEMORY is true', async () => {
      // Arrange
      vi.stubEnv('HEALTH_INCLUDE_MEMORY', 'true');
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body.memory).toBeDefined();
      expect(body.memory?.heapUsed).toBeDefined();
      expect(body.memory?.heapTotal).toBeDefined();
      expect(body.memory?.rss).toBeDefined();
      expect(body.memory?.percentage).toBeDefined();
      expect(vi.mocked(getMemoryUsage)).toHaveBeenCalled();
    });

    it('should return ok status without latency when latency is undefined', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.services.database.connected).toBe(true);
      expect(body.services.database.latency).toBeUndefined();
      expect(body.services.database.status).toBe('operational');
    });
  });

  /**
   * Service Status Indicators
   */
  describe('Service status indicators', () => {
    it('should return operational status for fast database', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 10,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body.services.database.status).toBe('operational');
    });

    it('should return degraded status for slow database (>500ms)', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 750,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.services.database.status).toBe('degraded');
      expect(body.services.database.connected).toBe(true);
    });

    it('should return outage status when database is disconnected', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(503);
      expect(body.services.database.status).toBe('outage');
      expect(body.services.database.connected).toBe(false);
    });
  });

  /**
   * Error Scenarios
   */
  describe('Error scenarios', () => {
    it('should return 503 and error status when database is not connected', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(503);
      expect(body.status).toBe('error');
      expect(body.services.database.connected).toBe(false);
      expect(body.services.database.status).toBe('outage');
    });

    it('should return 503 and log error when getDatabaseHealth throws', async () => {
      // Arrange
      const dbError = new Error('Database connection timeout');
      vi.mocked(getDatabaseHealth).mockRejectedValue(dbError);

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(503);
      expect(body.status).toBe('error');
      expect(body.services.database.connected).toBe(false);
      expect(body.services.database.status).toBe('outage');
      expect(body.error).toBe('Database connection timeout');
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Health check failed', dbError);
    });

    it('should handle non-Error exceptions gracefully', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockRejectedValue('String error');

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(503);
      expect(body.status).toBe('error');
      expect(body.error).toBe('Unknown error');
    });

    it('should include memory in error response when enabled', async () => {
      // Arrange
      vi.stubEnv('HEALTH_INCLUDE_MEMORY', 'true');
      vi.mocked(getDatabaseHealth).mockRejectedValue(new Error('DB error'));

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(503);
      expect(body.memory).toBeDefined();
    });
  });

  /**
   * Response Structure Validation
   */
  describe('Response structure', () => {
    it('should always include required fields', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 10,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('version');
      expect(body).toHaveProperty('uptime');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('services');
      expect(body.services).toHaveProperty('database');
      expect(body.services.database).toHaveProperty('status');
      expect(body.services.database).toHaveProperty('connected');
    });

    it('should include error field only when exception occurs', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockRejectedValue(new Error('Test error'));

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('Test error');
    });

    it('should not include error field when database is simply disconnected', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(body.error).toBeUndefined();
    });
  });

  /**
   * Edge Cases
   */
  describe('Edge cases', () => {
    it('should handle very high database latency', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5000,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.services.database.status).toBe('degraded');
      expect(body.services.database.latency).toBe(5000);
    });

    it('should handle zero latency', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 0,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert
      expect(response.status).toBe(200);
      expect(body.services.database.latency).toBe(0);
      expect(body.services.database.status).toBe('operational');
    });

    it('should handle concurrent health checks independently', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 10,
      });

      // Act
      const responses = await Promise.all([GET(), GET(), GET()]);

      // Assert
      expect(responses).toHaveLength(3);
      for (const response of responses) {
        expect(response.status).toBe(200);
        const body = await parseResponse<HealthResponse>(response);
        expect(body.status).toBe('ok');
      }
      expect(vi.mocked(getDatabaseHealth)).toHaveBeenCalledTimes(3);
    });

    it('should handle latency at boundary (exactly 500ms)', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 500,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: 500ms is not > 500, so still operational
      expect(body.services.database.status).toBe('operational');
    });

    it('should handle latency just above boundary (501ms)', async () => {
      // Arrange
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 501,
      });

      // Act
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: 501ms is > 500, so degraded
      expect(body.services.database.status).toBe('degraded');
    });
  });
});
