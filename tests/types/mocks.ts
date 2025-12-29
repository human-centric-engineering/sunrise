/**
 * Shared Mock Type Definitions for Tests
 *
 * Purpose: Provide complete, reusable mock types that satisfy both
 * TypeScript strict mode and ESLint requirements.
 *
 * WHY: Prevents recurring lint/type-check cycles by ensuring mock types
 * are complete from the start instead of being gradually fixed after
 * validation errors.
 */

import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

/**
 * Mock Headers object for testing Next.js server functions
 * Implements Partial<Headers> to satisfy TypeScript without requiring
 * all Headers methods (which we don't use in tests)
 */
export type MockHeaders = {
  get: (name: string) => string | null;
  has?: (name: string) => boolean;
  forEach?: (callback: (value: string, key: string, parent: Headers) => void) => void;
  entries?: () => IterableIterator<[string, string]>;
  keys?: () => IterableIterator<string>;
  values?: () => IterableIterator<string>;
};

/**
 * Factory function to create mock Headers
 * @param headers - Key-value pairs for header values
 * @returns MockHeaders instance with vi.fn() get method
 */
export function createMockHeaders(headers: Record<string, string> = {}): MockHeaders {
  return {
    get: vi.fn((name: string) => headers[name.toLowerCase()] ?? null),
    has: vi.fn((name: string) => name.toLowerCase() in headers),
    forEach: vi.fn(),
    entries: vi.fn(),
    keys: vi.fn(),
    values: vi.fn(),
  };
}

/**
 * Mock Session type for better-auth testing
 * Matches the structure returned by auth.api.getSession()
 */
export type MockSession = {
  session: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userId: string;
    expiresAt: Date;
    token: string;
    ipAddress?: string | null;
    userAgent?: string | null;
  };
  user: {
    id: string;
    email: string;
    name?: string | null;
    role?: string;
  };
};

/**
 * Factory function to create mock Session
 * @param overrides - Partial overrides for session and user properties
 * @returns Complete MockSession instance
 */
export function createMockSession(overrides?: {
  session?: Partial<MockSession['session']>;
  user?: Partial<MockSession['user']>;
}): MockSession {
  return {
    session: {
      id: 'test-session-id',
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      userId: 'test-user-id',
      expiresAt: new Date('2025-12-31'),
      token: 'test-token',
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      ...overrides?.session,
    },
    user: {
      id: 'test-user-id',
      email: 'test@example.com',
      name: 'Test User',
      role: 'USER',
      ...overrides?.user,
    },
  };
}

/**
 * Mock User type for database testing
 */
export type MockUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Factory function to create mock User
 * @param overrides - Partial overrides for user properties
 * @returns Complete MockUser instance
 */
export function createMockUser(overrides?: Partial<MockUser>): MockUser {
  return {
    id: 'test-user-id',
    email: 'test@example.com',
    name: 'Test User',
    role: 'USER',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

/**
 * Type-safe Prisma mock client
 * Avoids Promise vs PrismaPromise type mismatches by using vi.fn().mockResolvedValue
 */
export type MockPrismaClient = {
  $queryRaw: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
  $transaction: ReturnType<typeof vi.fn>;
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
};

/**
 * Create a properly typed Prisma mock
 * Uses mockResolvedValue instead of new Promise() to match PrismaPromise type
 *
 * @returns MockPrismaClient with all methods mocked
 */
export function createMockPrisma(): MockPrismaClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn((callback) =>
      callback({
        user: {
          findUnique: vi.fn(),
          findMany: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
      } as unknown as PrismaClient)
    ),
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
  };
}

/**
 * Helper for creating delayed async responses in tests
 * Avoids Promise vs PrismaPromise type issues
 *
 * @param value - Value to return after delay
 * @param ms - Delay in milliseconds
 * @returns Promise that resolves to value after delay
 */
export async function delayed<T>(value: T, ms: number): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return value;
}

/**
 * Mock Logger type for testing code that uses logger
 */
export type MockLogger = {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  withContext: ReturnType<typeof vi.fn>;
};

/**
 * Create a mock logger instance
 * @returns MockLogger with all methods mocked
 */
export function createMockLogger(): MockLogger {
  const mockLogger: MockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(() => mockLogger),
  };
  return mockLogger;
}
