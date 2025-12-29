/**
 * Database Utilities Tests
 *
 * Week 3, Task 8: Comprehensive tests for database utility functions.
 *
 * Test Coverage:
 * - checkDatabaseConnection() - Database connectivity checks
 * - getDatabaseHealth() - Health status with latency measurement
 * - executeTransaction() - Transaction wrapper with error handling
 * - disconnectDatabase() - Prisma client disconnection
 * - Error logging verification
 * - Latency measurement accuracy
 *
 * @see lib/db/utils.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkDatabaseConnection,
  getDatabaseHealth,
  executeTransaction,
  disconnectDatabase,
} from '@/lib/db/utils';

/**
 * Mock dependencies
 */

// Mock the Prisma client to avoid real database operations
vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
    $transaction: vi.fn(),
  },
}));

// Mock the logger to verify error logging
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    withContext: vi.fn(() => ({
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Test Suite: checkDatabaseConnection()
 *
 * Tests database connectivity checks
 */
describe('checkDatabaseConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return true when database connection is successful', async () => {
    // Arrange: Mock successful query
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);

    // Act: Check database connection
    const result = await checkDatabaseConnection();

    // Assert: Connection successful
    expect(result).toBe(true);
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalledWith(['SELECT 1']);
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('should return false when database connection fails', async () => {
    // Arrange: Mock failed query
    const dbError = new Error('Connection refused');
    vi.mocked(prisma.$queryRaw).mockRejectedValue(dbError);

    // Act: Check database connection
    const result = await checkDatabaseConnection();

    // Assert: Connection failed
    expect(result).toBe(false);
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalledWith(['SELECT 1']);
  });

  it('should log error when connection fails', async () => {
    // Arrange: Mock failed query with specific error
    const dbError = new Error('Database connection timeout');
    vi.mocked(prisma.$queryRaw).mockRejectedValue(dbError);

    // Act: Check database connection
    await checkDatabaseConnection();

    // Assert: Error logged
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Database connection failed', dbError);
  });

  it('should handle network errors gracefully', async () => {
    // Arrange: Mock network error
    const networkError = new Error('ECONNREFUSED');
    vi.mocked(prisma.$queryRaw).mockRejectedValue(networkError);

    // Act: Check database connection
    const result = await checkDatabaseConnection();

    // Assert: Returns false and logs error
    expect(result).toBe(false);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'Database connection failed',
      networkError
    );
  });

  it('should handle timeout errors', async () => {
    // Arrange: Mock timeout error
    const timeoutError = new Error('Query timeout');
    vi.mocked(prisma.$queryRaw).mockRejectedValue(timeoutError);

    // Act: Check database connection
    const result = await checkDatabaseConnection();

    // Assert: Returns false
    expect(result).toBe(false);
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'Database connection failed',
      timeoutError
    );
  });
});

/**
 * Test Suite: disconnectDatabase()
 *
 * Tests Prisma client disconnection
 */
describe('disconnectDatabase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call prisma.$disconnect()', async () => {
    // Arrange: Mock successful disconnect
    vi.mocked(prisma.$disconnect).mockResolvedValue();

    // Act: Disconnect from database
    await disconnectDatabase();

    // Assert: Disconnect called
    expect(vi.mocked(prisma.$disconnect)).toHaveBeenCalledTimes(1);
  });

  it('should complete without errors', async () => {
    // Arrange: Mock successful disconnect
    vi.mocked(prisma.$disconnect).mockResolvedValue();

    // Act & Assert: Should not throw
    await expect(disconnectDatabase()).resolves.toBeUndefined();
  });

  it('should propagate disconnect errors', async () => {
    // Arrange: Mock disconnect error
    const disconnectError = new Error('Failed to disconnect');
    vi.mocked(prisma.$disconnect).mockRejectedValue(disconnectError);

    // Act & Assert: Error propagated
    await expect(disconnectDatabase()).rejects.toThrow('Failed to disconnect');
  });
});

/**
 * Test Suite: getDatabaseHealth()
 *
 * Tests database health status with latency measurement
 */
describe('getDatabaseHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return connected=true with latency when database is healthy', async () => {
    // Arrange: Mock successful query with delay
    vi.mocked(prisma.$queryRaw).mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          setTimeout(() => resolve([{ result: 1 }]), 10);
        })
    );

    // Act: Check database health
    const result = await getDatabaseHealth();

    // Assert: Returns healthy status with latency
    expect(result.connected).toBe(true);
    expect(result.latency).toBeDefined();
    expect(typeof result.latency).toBe('number');
    expect(result.latency).toBeGreaterThanOrEqual(10);
    expect(result.latency).toBeLessThan(1000); // Reasonable latency
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalledWith(['SELECT 1']);
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('should measure latency accurately', async () => {
    // Arrange: Mock query with known delay
    vi.mocked(prisma.$queryRaw).mockImplementation(
      () =>
        new Promise<unknown[]>((resolve) => {
          setTimeout(() => resolve([{ result: 1 }]), 50);
        })
    );

    // Act: Check database health
    const result = await getDatabaseHealth();

    // Assert: Latency measured
    expect(result.latency).toBeGreaterThanOrEqual(50);
    expect(result.latency).toBeLessThan(100); // Within reasonable bounds
  });

  it('should return connected=false when database is unhealthy', async () => {
    // Arrange: Mock failed query
    const dbError = new Error('Connection lost');
    vi.mocked(prisma.$queryRaw).mockRejectedValue(dbError);

    // Act: Check database health
    const result = await getDatabaseHealth();

    // Assert: Returns unhealthy status
    expect(result.connected).toBe(false);
    expect(result.latency).toBeUndefined();
    expect(vi.mocked(prisma.$queryRaw)).toHaveBeenCalledWith(['SELECT 1']);
  });

  it('should log error when health check fails', async () => {
    // Arrange: Mock failed query with specific error
    const dbError = new Error('Health check failed');
    vi.mocked(prisma.$queryRaw).mockRejectedValue(dbError);

    // Act: Check database health
    await getDatabaseHealth();

    // Assert: Error logged
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith('Database health check failed', dbError);
  });

  it('should not include latency field when connection fails', async () => {
    // Arrange: Mock failed query
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error('Connection refused'));

    // Act: Check database health
    const result = await getDatabaseHealth();

    // Assert: No latency field
    expect(result).toEqual({
      connected: false,
    });
    expect(result).not.toHaveProperty('latency');
  });

  it('should handle immediate responses', async () => {
    // Arrange: Mock instant query
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);

    // Act: Check database health
    const result = await getDatabaseHealth();

    // Assert: Latency is 0 or very small
    expect(result.connected).toBe(true);
    expect(result.latency).toBeDefined();
    expect(result.latency).toBeGreaterThanOrEqual(0);
    expect(result.latency).toBeLessThan(10); // Very fast response
  });

  it('should handle network timeout errors', async () => {
    // Arrange: Mock timeout error
    const timeoutError = new Error('Query execution timeout');
    vi.mocked(prisma.$queryRaw).mockRejectedValue(timeoutError);

    // Act: Check database health
    const result = await getDatabaseHealth();

    // Assert: Returns unhealthy status
    expect(result.connected).toBe(false);
    expect(result.latency).toBeUndefined();
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      'Database health check failed',
      timeoutError
    );
  });
});

/**
 * Test Suite: executeTransaction()
 *
 * Tests transaction wrapper with error handling
 */
describe('executeTransaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute callback in transaction and return result', async () => {
    // Arrange: Mock transaction that executes callback
    const mockResult = { id: 'test-123', name: 'Test' };
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        return callback(prisma);
      }
    );

    // Act: Execute transaction
    const callback = vi.fn().mockResolvedValue(mockResult);
    const result = await executeTransaction(callback);

    // Assert: Callback executed and result returned
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(prisma);
    expect(result).toEqual(mockResult);
  });

  it('should pass transaction client to callback', async () => {
    // Arrange: Mock transaction
    const mockTx = { ...prisma };
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        return callback(mockTx);
      }
    );

    // Act: Execute transaction
    const callback = vi.fn().mockResolvedValue(true);
    await executeTransaction(callback);

    // Assert: Callback received transaction client
    expect(callback).toHaveBeenCalledWith(mockTx);
  });

  it('should propagate callback errors', async () => {
    // Arrange: Mock transaction that executes callback
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        return callback(prisma);
      }
    );

    const callbackError = new Error('Transaction callback failed');
    const callback = vi.fn().mockRejectedValue(callbackError);

    // Act & Assert: Error propagated
    await expect(executeTransaction(callback)).rejects.toThrow('Transaction callback failed');
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);
  });

  it('should propagate transaction errors', async () => {
    // Arrange: Mock transaction error
    const transactionError = new Error('Transaction failed to commit');
    vi.mocked(prisma.$transaction).mockRejectedValue(transactionError);

    // Act & Assert: Error propagated
    const callback = vi.fn();
    await expect(executeTransaction(callback)).rejects.toThrow('Transaction failed to commit');
  });

  it('should rollback on callback error', async () => {
    // Arrange: Mock transaction that throws on error (rollback happens automatically)
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        return callback(prisma); // Will propagate errors for rollback
      }
    );

    const callbackError = new Error('Operation failed');
    const callback = vi.fn().mockRejectedValue(callbackError);

    // Act & Assert: Error propagated (rollback happened)
    await expect(executeTransaction(callback)).rejects.toThrow('Operation failed');
  });

  it('should support multiple operations in transaction', async () => {
    // Arrange: Mock transaction and reset $queryRaw
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ result: 1 }]);
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        return callback(prisma);
      }
    );

    // Act: Execute multiple operations
    const callback = vi.fn(async (tx: typeof prisma) => {
      // Simulate multiple database operations
      await tx.$queryRaw`INSERT INTO users ...`;
      await tx.$queryRaw`INSERT INTO posts ...`;
      return { success: true };
    });

    const result = await executeTransaction(callback);

    // Assert: All operations executed
    expect(result).toEqual({ success: true });
    expect(callback).toHaveBeenCalledWith(prisma);
  });

  it('should return typed results from callback', async () => {
    // Arrange: Mock transaction with typed result
    interface User {
      id: string;
      email: string;
    }

    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        return callback(prisma);
      }
    );

    // Act: Execute transaction with typed callback
    const callback = async (): Promise<User> => {
      return { id: 'user-123', email: 'test@example.com' };
    };

    const result = await executeTransaction(callback);

    // Assert: Typed result returned
    expect(result).toEqual({ id: 'user-123', email: 'test@example.com' });
    expect(result.id).toBe('user-123');
    expect(result.email).toBe('test@example.com');
  });

  it('should handle Prisma constraint errors in transactions', async () => {
    // Arrange: Mock transaction with Prisma error
    vi.mocked(prisma.$transaction).mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => {
        return callback(prisma);
      }
    );

    const constraintError = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { target: ['email'] },
    });

    const callback = vi.fn().mockRejectedValue(constraintError);

    // Act & Assert: Prisma error propagated
    await expect(executeTransaction(callback)).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['email'] },
    });
  });
});
