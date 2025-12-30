/**
 * Integration Test: Health Check API Endpoint
 *
 * Week 4: Integration Testing Example
 *
 * This test demonstrates integration testing patterns for Next.js API routes:
 * - Testing API route handlers (GET /api/health)
 * - Mocking database dependencies (getDatabaseHealth)
 * - Mocking logger for verification
 * - Testing both success and error scenarios
 * - Verifying response structure and HTTP status codes
 * - Real endpoint invocation (not mocked fetch)
 *
 * Key Patterns:
 * - Integration test: Tests the actual route handler function
 * - Mocked dependencies: Database and logger are mocked for isolation
 * - Response validation: Verifies JSON structure and status codes
 * - Error handling: Tests exception scenarios
 *
 * @see app/api/health/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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

// Import mocked modules
import { getDatabaseHealth } from '@/lib/db/utils';
import { logger } from '@/lib/logging';

/**
 * Helper function to parse JSON response
 */
async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return JSON.parse(text) as T;
}

/**
 * Response type interfaces
 */
interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  database: {
    connected: boolean;
    latency?: number;
  };
  error?: string;
}

/**
 * Test Suite: GET /api/health
 */
describe('GET /api/health', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.clearAllMocks();
  });

  /**
   * Success Scenarios
   */
  describe('Success scenarios', () => {
    it('should return 200 and ok status when database is connected', async () => {
      // Arrange: Mock successful database health check
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Response structure and values
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        status: 'ok',
        database: {
          connected: true,
          latency: 5,
        },
      });
      expect(body.timestamp).toBeDefined();
      expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');

      // Assert: Database health check was called
      expect(vi.mocked(getDatabaseHealth)).toHaveBeenCalledTimes(1);

      // Assert: No errors logged
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });

    it('should return database latency when available', async () => {
      // Arrange: Mock database health with latency
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 25,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Latency is included in response
      expect(response.status).toBe(200);
      expect(body.database.latency).toBe(25);
      expect(body.database.connected).toBe(true);
    });

    it('should return ok status without latency when latency is undefined', async () => {
      // Arrange: Mock database health without latency
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Latency is not included in response
      expect(response.status).toBe(200);
      expect(body.database.connected).toBe(true);
      expect(body.database.latency).toBeUndefined();
      expect(body.status).toBe('ok');
    });
  });

  /**
   * Error Scenarios
   */
  describe('Error scenarios', () => {
    it('should return 503 and error status when database is not connected', async () => {
      // Arrange: Mock failed database health check
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Response indicates service unavailable
      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        status: 'error',
        database: {
          connected: false,
        },
      });
      expect(body.timestamp).toBeDefined();

      // Assert: Database health check was called
      expect(vi.mocked(getDatabaseHealth)).toHaveBeenCalledTimes(1);

      // Assert: No errors logged (disconnected state, not exception)
      expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
    });

    it('should not include latency when database is disconnected', async () => {
      // Arrange: Mock disconnected database
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Latency is not included
      expect(response.status).toBe(503);
      expect(body.database.latency).toBeUndefined();
      expect(body.database.connected).toBe(false);
    });

    it('should return 503 and log error when getDatabaseHealth throws', async () => {
      // Arrange: Mock database health check throwing error
      const dbError = new Error('Database connection timeout');
      vi.mocked(getDatabaseHealth).mockRejectedValue(dbError);

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Response indicates service unavailable
      expect(response.status).toBe(503);
      expect(body.status).toBe('error');
      expect(body.database.connected).toBe(false);
      expect(body.error).toBe('Database connection timeout');
      expect(body.timestamp).toBeDefined();

      // Assert: Error was logged
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Health check failed', dbError);
    });

    it('should handle non-Error exceptions gracefully', async () => {
      // Arrange: Mock database health check throwing non-Error value
      vi.mocked(getDatabaseHealth).mockRejectedValue('String error');

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Response indicates service unavailable
      expect(response.status).toBe(503);
      expect(body.status).toBe('error');
      expect(body.database.connected).toBe(false);
      expect(body.error).toBe('Unknown error');

      // Assert: Error was logged
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Health check failed', 'String error');
    });
  });

  /**
   * Response Structure Validation
   */
  describe('Response structure', () => {
    it('should always include required fields', async () => {
      // Arrange: Mock successful database health
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 10,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: All required fields are present
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('timestamp');
      expect(body).toHaveProperty('database');
      expect(body.database).toHaveProperty('connected');
    });

    it('should return ISO 8601 timestamp format', async () => {
      // Arrange: Mock successful database health
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Timestamp is valid ISO 8601
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(body.timestamp).toString()).not.toBe('Invalid Date');
    });

    it('should include error field only when exception occurs', async () => {
      // Arrange: Mock database health check throwing error
      vi.mocked(getDatabaseHealth).mockRejectedValue(new Error('Test error'));

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Error field is present
      expect(body).toHaveProperty('error');
      expect(body.error).toBe('Test error');
    });

    it('should not include error field when database is simply disconnected', async () => {
      // Arrange: Mock disconnected database (not an exception)
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: false,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Error field is not present
      expect(body).not.toHaveProperty('error');
      expect(body.status).toBe('error');
    });
  });

  /**
   * Edge Cases
   */
  describe('Edge cases', () => {
    it('should handle very high database latency', async () => {
      // Arrange: Mock high latency (e.g., slow network)
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 5000, // 5 seconds
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Still returns ok status with latency
      expect(response.status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.database.latency).toBe(5000);
    });

    it('should handle zero latency', async () => {
      // Arrange: Mock zero latency (instant response)
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 0,
      });

      // Act: Call the health endpoint
      const response = await GET();
      const body = await parseResponse<HealthResponse>(response);

      // Assert: Zero latency is included
      expect(response.status).toBe(200);
      expect(body.database.latency).toBe(0);
    });

    it('should handle concurrent health checks independently', async () => {
      // Arrange: Mock successful database health
      vi.mocked(getDatabaseHealth).mockResolvedValue({
        connected: true,
        latency: 10,
      });

      // Act: Call health endpoint multiple times concurrently
      const responses = await Promise.all([GET(), GET(), GET()]);

      // Assert: All responses are successful
      expect(responses).toHaveLength(3);
      for (const response of responses) {
        expect(response.status).toBe(200);
        const body = await parseResponse<HealthResponse>(response);
        expect(body.status).toBe('ok');
      }

      // Assert: Database health check called for each request
      expect(vi.mocked(getDatabaseHealth)).toHaveBeenCalledTimes(3);
    });
  });
});
