/**
 * Tests: Prisma Client Singleton (lib/db/client.ts)
 *
 * lib/db/client.ts executes at import time — it creates a pg Pool,
 * a PrismaPg adapter, and a PrismaClient at the module top level.
 *
 * Each test uses vi.resetModules() + vi.doMock() + dynamic import() to
 * re-trigger the module initialization with controlled mocks per test.
 * This pattern is required because the singletons are created at module scope.
 *
 * Test Coverage:
 * - Exports a non-null prisma client instance (smoke test)
 * - Production: does NOT cache on globalForPrisma (guard prevents caching)
 * - Development: caches prisma on globalForPrisma (hot-reload reuse)
 * - Development: caches pool on globalForPrisma (hot-reload reuse)
 * - Development: PrismaClient created with ['query', 'error', 'warn'] log config
 * - Production: PrismaClient created with ['error'] only log config
 *
 * @see lib/db/client.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Clear globalForPrisma cache between tests.
 * lib/db/client.ts reads globalThis.prisma and globalThis.pool before
 * deciding whether to construct new instances.
 */
function clearGlobalCache(): void {
  const g = globalThis as unknown as { prisma?: unknown; pool?: unknown };
  delete g.prisma;
  delete g.pool;
}

/**
 * Re-import lib/db/client.ts fresh with controlled mocks for a given NODE_ENV.
 *
 * Uses vi.resetModules() + vi.doMock() (not hoisted, re-registers each call)
 * so that each test sees a fresh module execution with the correct env.
 *
 * Returns the client module exports plus the mock constructors for assertion.
 */
async function importClientWithEnv(opts: {
  NODE_ENV: string;
  DATABASE_URL?: string;
  preSeededGlobal?: { prisma?: unknown; pool?: unknown };
}) {
  const {
    NODE_ENV,
    DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb',
    preSeededGlobal,
  } = opts;

  // Apply pre-seeded globals before module load (simulates hot-reload cache)
  if (preSeededGlobal) {
    const g = globalThis as unknown as { prisma?: unknown; pool?: unknown };
    if (preSeededGlobal.prisma !== undefined) g.prisma = preSeededGlobal.prisma;
    if (preSeededGlobal.pool !== undefined) g.pool = preSeededGlobal.pool;
  }

  // Create fresh mock instances for this import cycle

  const MockPool = vi.fn(function (this: any, _opts?: unknown) {
    this.connect = vi.fn();
    this.end = vi.fn();
    this.__type = 'MockPool';
  });

  const MockPrismaPg = vi.fn(function (this: any, _pool?: unknown) {
    this.__type = 'MockPrismaPg';
  });

  const MockPrismaClient = vi.fn(function (this: any, _options?: unknown) {
    this.$disconnect = vi.fn();
    this.__type = 'MockPrismaClient';
  });

  const mockEnvValue = { DATABASE_URL, NODE_ENV };

  // Reset the module registry and re-register mocks (vi.doMock is not hoisted)
  vi.resetModules();

  vi.doMock('pg', () => ({ Pool: MockPool }));
  vi.doMock('@prisma/adapter-pg', () => ({ PrismaPg: MockPrismaPg }));
  vi.doMock('@prisma/client', () => ({ PrismaClient: MockPrismaClient }));
  vi.doMock('@/lib/env', () => ({ env: mockEnvValue }));

  const clientMod = await import('@/lib/db/client');

  return {
    prisma: clientMod.prisma,
    default: clientMod.default,
    MockPool,
    MockPrismaPg,
    MockPrismaClient,
  };
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearGlobalCache();
});

afterEach(() => {
  clearGlobalCache();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('lib/db/client', () => {
  describe('Basic export — smoke test', () => {
    it('should export a prisma client instance (not undefined/null)', async () => {
      // Arrange + Act
      const { prisma, default: defaultExport } = await importClientWithEnv({
        NODE_ENV: 'development',
      });

      // Assert — named and default exports both reference the mock PrismaClient instance
      expect(prisma).toBeDefined();
      expect(prisma).not.toBeNull();
      expect(defaultExport).toBeDefined();
      expect(prisma).toBe(defaultExport);
    });
  });

  describe('Pool construction', () => {
    it('should create a Pool with the DATABASE_URL connection string', async () => {
      // Arrange + Act
      const { MockPool } = await importClientWithEnv({
        NODE_ENV: 'development',
        DATABASE_URL: 'postgresql://testuser:testpass@db:5432/appdb',
      });

      // Assert — Pool was constructed with the correct connectionString
      expect(MockPool).toHaveBeenCalledWith({
        connectionString: 'postgresql://testuser:testpass@db:5432/appdb',
      });
    });

    it('should pass the Pool instance to PrismaPg adapter', async () => {
      // Arrange + Act
      const { MockPool, MockPrismaPg } = await importClientWithEnv({ NODE_ENV: 'development' });

      // Assert — PrismaPg received the pool instance created by Pool constructor
      const poolInstance = MockPool.mock.instances[0] as unknown;
      expect(poolInstance).toBeDefined();
      expect(MockPrismaPg).toHaveBeenCalledWith(poolInstance);
    });
  });

  describe('PrismaClient log config', () => {
    it('should create PrismaClient with query/error/warn logs in development', async () => {
      // Arrange + Act
      const { MockPrismaClient } = await importClientWithEnv({ NODE_ENV: 'development' });

      // Assert — log array includes 'query' and 'warn' (development verbosity)
      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          log: ['query', 'error', 'warn'],
        })
      );
    });

    it('should create PrismaClient with error-only logs in production', async () => {
      // Arrange + Act
      const { MockPrismaClient } = await importClientWithEnv({ NODE_ENV: 'production' });

      // Assert — log array contains only 'error'
      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          log: ['error'],
        })
      );
    });

    it('should pass the PrismaPg adapter instance to PrismaClient constructor', async () => {
      // Arrange + Act
      const { MockPrismaPg, MockPrismaClient } = await importClientWithEnv({
        NODE_ENV: 'development',
      });

      // Assert — PrismaClient received the adapter created by PrismaPg constructor
      const adapterInstance = MockPrismaPg.mock.instances[0] as unknown;
      expect(adapterInstance).toBeDefined();
      expect(MockPrismaClient).toHaveBeenCalledWith(
        expect.objectContaining({
          adapter: adapterInstance,
        })
      );
    });
  });

  describe('Singleton caching — non-production (development)', () => {
    it('should cache prisma on globalForPrisma in development', async () => {
      // Arrange + Act
      const { prisma } = await importClientWithEnv({ NODE_ENV: 'development' });

      // Assert — the module wrote the instance into globalThis
      const g = globalThis as unknown as { prisma?: unknown };
      expect(g.prisma).toBeDefined();
      expect(g.prisma).toBe(prisma);
    });

    it('should cache pool on globalForPrisma in development', async () => {
      // Arrange + Act
      const { MockPool } = await importClientWithEnv({ NODE_ENV: 'development' });

      // Assert — the pool was written into globalThis
      const g = globalThis as unknown as { pool?: unknown };
      expect(g.pool).toBeDefined();
      // The cached pool must be the instance created by the Pool constructor
      const poolInstance = MockPool.mock.instances[0] as unknown;
      expect(g.pool).toBe(poolInstance);
    });

    it('should reuse the cached prisma from globalForPrisma (hot-reload reuse)', async () => {
      // Arrange — pre-seed globalThis with a cached instance to simulate hot-reload
      const cachedPrisma = { __type: 'CachedPrismaClient', $disconnect: vi.fn() };
      const cachedPool = { __type: 'CachedPool', connect: vi.fn() };

      // Act — pass pre-seeded globals so the module finds them at load time
      const { prisma, MockPrismaClient } = await importClientWithEnv({
        NODE_ENV: 'development',
        preSeededGlobal: { prisma: cachedPrisma, pool: cachedPool },
      });

      // Assert — module returned the cached instance without calling the constructor
      expect(prisma).toBe(cachedPrisma);
      expect(MockPrismaClient).not.toHaveBeenCalled();
    });
  });

  describe('Singleton caching — production', () => {
    it('should NOT cache prisma on globalForPrisma in production', async () => {
      // Arrange + Act
      await importClientWithEnv({ NODE_ENV: 'production' });

      // Assert — production never writes to globalThis (guard: NODE_ENV !== 'production')
      const g = globalThis as unknown as { prisma?: unknown };
      expect(g.prisma).toBeUndefined();
    });

    it('should NOT cache pool on globalForPrisma in production', async () => {
      // Arrange + Act
      await importClientWithEnv({ NODE_ENV: 'production' });

      // Assert — pool not cached in production
      const g = globalThis as unknown as { pool?: unknown };
      expect(g.pool).toBeUndefined();
    });
  });
});
