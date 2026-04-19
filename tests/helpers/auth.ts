/**
 * Authentication Test Helpers
 *
 * Utilities for mocking authentication in tests.
 */

import { vi } from 'vitest';

// Narrow to the shape better-auth actually exposes on session.user (see
// lib/auth/config.ts — `role` is the only additionalField). The Prisma
// User model has extended-profile fields (bio, phone, preferences, ...)
// that the auth layer does NOT project onto session.user, so tests must
// not reach for them.
interface MockSessionUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
  role: 'USER' | 'ADMIN';
}

interface MockSession {
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    token: string;
    createdAt: Date;
    updatedAt: Date;
  };
  user: MockSessionUser;
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
export function mockAuthenticatedUser(role: 'USER' | 'ADMIN' = 'USER') {
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
