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

import { vi, type Mock } from 'vitest';
import type { useRouter } from 'next/navigation';
import type { Logger } from '@/lib/logging';

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
    createdAt: Date;
    updatedAt: Date;
    email: string;
    emailVerified: boolean;
    name: string;
    image?: string | null;
    role: string | null | undefined;
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
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
      email: 'test@example.com',
      emailVerified: true,
      name: 'Test User',
      image: null,
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
  accountType: string;
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
    accountType: 'HUMAN',
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
      })
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
 * Mock App Router type for testing components that call `useRouter()`.
 *
 * Intersects with the real return type of `useRouter` so the mock is
 * assignable wherever the router is expected, while typing each method as
 * `Mock` so `.toHaveBeenCalledWith(...)` works at the call site without a
 * `vi.mocked(...)` wrapper — the same shape as `MockLogger` below.
 *
 * `ReturnType<typeof useRouter>` is deliberately used in place of importing
 * `AppRouterInstance`, which lives under `next/dist/shared/lib/...` and is not
 * part of Next's public surface.
 */
export type MockRouter = ReturnType<typeof useRouter> & {
  push: Mock;
  replace: Mock;
  refresh: Mock;
  back: Mock;
  forward: Mock;
  prefetch: Mock;
};

/**
 * Create a complete mock App Router.
 *
 * WHY THIS EXISTS: `AppRouterInstance` gains required members between Next
 * minors — 16.3.0 added `bfcacheId`, which broke every hand-rolled router
 * literal in the suite at once. Routing every type-checked call site through
 * one factory makes the next such addition a one-line change here instead of
 * another sweep, and spares forks repeating it.
 *
 * Two things defeat that. An `as unknown as ReturnType<typeof useRouter>`
 * cast suppresses the error rather than fixing it, so the literal rots in
 * silence — there are none left in the suite, and none should be added. An
 * incomplete literal inside a `vi.mock` factory has the same effect, because
 * nothing type-checks a mock factory; `tests/setup.ts` builds the suite-wide
 * default from this factory for that reason, and
 * `tests/unit/types/mocks.test.ts` asserts it still does.
 *
 * Scope is an enforced invariant, not a claim: `/pre-pr` check 4m scans every
 * `.ts`/`.tsx` under `tests/` — including `setup.ts`, `helpers/` and `mocks/`,
 * not just `*.test.ts` — for both shapes, and must come back clean. Minimal
 * stubs that supply two or three members for a component reading nothing else
 * are deliberately allowed and not counted; convert one the moment its
 * component might read more of the router than the stub provides.
 *
 * It is worded as "run the check" because prose kept getting it wrong. Four
 * review rounds running, a comment here asserted a completeness the code had
 * not reached — the scanner behind the last number matched
 * `useRouter: vi.fn(() => ({…}))` and silently missed `useRouter: () => ({…})`,
 * then its replacement missed single-line literals and every file outside
 * `*.test.ts`. Run 4m; do not restate a count here.
 *
 * `bfcacheId` is a fixed string, not a spy. Its real semantics are that it
 * *changes* on a fresh push/replace navigation, so a test asserting that a
 * `key={router.bfcacheId}` subtree remounts must pass a different value
 * itself — a constant makes the remount never fire.
 *
 * @param overrides - Replace individual members (usually a shared `push` or
 *                    `replace` spy the test asserts against)
 * @returns Complete MockRouter instance
 */
export function createMockRouter(overrides?: Partial<MockRouter>): MockRouter {
  // `undefined` values are dropped rather than spread. `Partial<MockRouter>`
  // with `exactOptionalPropertyTypes` off accepts `{ push: maybeSpy }` where
  // `maybeSpy` is `Mock | undefined`, and a plain spread would then overwrite
  // the default with `undefined` — producing a router that type-checks as
  // complete and throws "router.push is not a function" at render. That is the
  // exact failure this factory exists to prevent, so it must not be reachable
  // through the factory itself.
  const supplied = Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined);

  return {
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
    bfcacheId: 'test-bfcache-id',
    ...Object.fromEntries(supplied),
  };
}

/**
 * Mock Logger type for testing code that uses the Logger class.
 *
 * Intersects with `Logger` so the mock is assignable wherever a real `Logger`
 * is expected (e.g. `mockResolvedValue(mockLog)` for a `getRouteLogger` mock).
 * Methods are typed as `Mock` so `.toHaveBeenCalledWith(...)` etc. work
 * directly without a `vi.mocked(...)` wrapper at the call site.
 */
export type MockLogger = Logger & {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  child: Mock;
  withContext: Mock;
};

/**
 * Create a mock logger instance.
 *
 * The `Logger` class has private fields, so a plain object cannot satisfy it
 * structurally. The cast is localised inside the factory so callers never
 * need `as unknown as Logger` at the call site.
 */
export function createMockLogger(): MockLogger {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withContext: vi.fn(),
  };
  mockLogger.child.mockReturnValue(mockLogger);
  mockLogger.withContext.mockReturnValue(mockLogger);
  return mockLogger as unknown as MockLogger;
}
