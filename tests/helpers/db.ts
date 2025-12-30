/**
 * Database Test Helpers
 *
 * Utilities for testing database operations with Prisma.
 * For Week 1, these are placeholder helpers that will be expanded in later weeks
 * when we implement integration tests.
 */

import { vi } from 'vitest';
import type { User, Session } from '@/types/prisma';

/**
 * Mock Prisma Client for unit tests
 *
 * Use this when you need to mock database operations without a real database.
 *
 * @example
 * ```ts
 * import { mockPrismaClient } from '@/tests/helpers/db';
 *
 * vi.mock('@/lib/db', () => ({
 *   db: mockPrismaClient
 * }));
 * ```
 */
export const mockPrismaClient = {
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(),
  },
  session: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  account: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  verification: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  // Add more models as needed
};

/**
 * Reset all database mocks
 *
 * Call this in afterEach() to ensure clean state between tests
 */
export function resetDbMocks() {
  vi.resetAllMocks();
}

/**
 * Create mock user data
 *
 * Generates realistic user data for testing
 */
export function createMockUser(overrides?: Partial<User>): User {
  return {
    id: 'cmjbv4i3x00003wsloputgwul',
    email: 'test@example.com',
    name: 'Test User',
    emailVerified: false,
    image: null,
    role: 'USER',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Create mock session data
 *
 * Generates realistic session data for testing
 */
export function createMockSession(userId?: string, overrides?: Partial<Session>): Session {
  return {
    id: 'session_123',
    userId: userId || 'cmjbv4i3x00003wsloputgwul',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    token: 'mock_session_token',
    ipAddress: null,
    userAgent: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

/**
 * Note: Integration test helpers (seedTestData, cleanupTestData, etc.)
 * will be implemented in Week 3 when we add API route integration tests.
 */
