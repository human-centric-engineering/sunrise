/**
 * Authentication Test Helpers
 *
 * Utilities for mocking authentication in tests.
 */

import { vi } from 'vitest';
import type { User } from '@/types/prisma';

interface MockSession {
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    token: string;
    createdAt: Date;
    updatedAt: Date;
  };
  user: User;
}

/**
 * Mock better-auth session
 *
 * Creates a mock session object for testing authenticated routes
 */
export function createMockAuthSession(overrides?: Partial<MockSession>): MockSession {
  return {
    session: {
      id: 'session_123',
      userId: 'cmjbv4i3x00003wsloputgwul',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      token: 'mock_session_token',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    user: {
      id: 'cmjbv4i3x00003wsloputgwul',
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: false,
      image: null,
      role: 'USER',
      createdAt: new Date(),
      updatedAt: new Date(),
      // Extended profile fields (Phase 3.2)
      bio: null,
      phone: null,
      timezone: 'UTC',
      location: null,
      preferences: {},
    },
    ...overrides,
  };
}

/**
 * Mock better-auth getSession function
 *
 * Use this to mock authentication in API routes and Server Components
 *
 * @example
 * ```ts
 * vi.mock('@/lib/auth/server', () => ({
 *   getSession: mockGetSession(createMockAuthSession())
 * }));
 * ```
 */
export function mockGetSession(session: MockSession | null) {
  return vi.fn(async () => Promise.resolve(session));
}

/**
 * Mock authenticated user
 *
 * Returns a complete mock session for an authenticated user
 */
export function mockAuthenticatedUser(role: 'USER' | 'ADMIN' | 'MODERATOR' = 'USER') {
  return createMockAuthSession({
    user: {
      id: 'cmjbv4i3x00003wsloputgwul',
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      // Extended profile fields (Phase 3.2)
      bio: null,
      phone: null,
      timezone: 'UTC',
      location: null,
      preferences: {},
    },
  });
}

/**
 * Mock unauthenticated user
 *
 * Returns null to simulate no active session
 */
export function mockUnauthenticatedUser() {
  return null;
}

/**
 * Mock admin user
 *
 * Returns a complete mock session for an admin user
 */
export function mockAdminUser() {
  return mockAuthenticatedUser('ADMIN');
}

/**
 * Mock moderator user
 *
 * Returns a complete mock session for a moderator user
 */
export function mockModeratorUser() {
  return mockAuthenticatedUser('MODERATOR');
}
