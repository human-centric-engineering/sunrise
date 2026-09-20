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
 * - Tenancy seam: the exported client is the base client through `withTenancy`
 *   in both modes (the extension itself is tested in tenancy-extension.test.ts)
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
  DATABASE_POOL_MAX?: number;
  TENANCY_MODE?: string;
  preSeededGlobal?: { prisma?: unknown; pool?: unknown };
}) {
  const {
    NODE_ENV,
    DATABASE_URL = 'postgresql://user:pass@localhost:5432/testdb',
    DATABASE_POOL_MAX,
    TENANCY_MODE,
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

  // The chokepoint wraps the base client; here it is a pass-through that
  // records what it was handed, so these tests stay about the singleton.
  const mockWithTenancy = vi.fn((base: unknown, _options: unknown) => ({
    __type: 'TenancyClient',
    base,
  }));
  const mockContext = {
    getTenantContext: vi.fn(),
    isMultiTenant: vi.fn(() => false),
  };

  // Only set TENANCY_MODE on the mock env when the test supplies it, so the
  // "undefined behaves like single" back-compat case is genuinely undefined.
  const mockEnvValue: {
    DATABASE_URL: string;
    NODE_ENV: string;
    DATABASE_POOL_MAX?: number;
    TENANCY_MODE?: string;
  } = {
    DATABASE_URL,
    NODE_ENV,
  };
  if (TENANCY_MODE !== undefined) mockEnvValue.TENANCY_MODE = TENANCY_MODE;
  // Left genuinely absent when the test doesn't supply it, so the default-10
  // path is exercised the way an install with no override sees it.
  if (DATABASE_POOL_MAX !== undefined) mockEnvValue.DATABASE_POOL_MAX = DATABASE_POOL_MAX;

  // Reset the module registry and re-register mocks (vi.doMock is not hoisted)
  vi.resetModules();

  vi.doMock('pg', () => ({ Pool: MockPool }));
  vi.doMock('@prisma/adapter-pg', () => ({ PrismaPg: MockPrismaPg }));
  vi.doMock('@prisma/client', () => ({ PrismaClient: MockPrismaClient }));
  vi.doMock('@/lib/env', () => ({ env: mockEnvValue }));
  vi.doMock('@/lib/db/tenancy-extension', () => ({ withTenancy: mockWithTenancy }));
  vi.doMock('@/lib/tenancy/context', () => mockContext);

  const clientMod = await import('@/lib/db/client');

  return {
    prisma: clientMod.prisma,
    default: clientMod.default,
    MockPool,
    MockPrismaPg,
    MockPrismaClient,
    mockWithTenancy,
    mockContext,
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
      expect(MockPool).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: 'postgresql://testuser:testpass@db:5432/appdb',
        })
      );
    });

    it('should default max to 10 when DATABASE_POOL_MAX is unset', async () => {
      // Arrange + Act — no override, the shape a plain docker-compose install sees
      const { MockPool } = await importClientWithEnv({ NODE_ENV: 'production' });

      // Assert — node-postgres' own default, sized for one long-running process
      expect(MockPool).toHaveBeenCalledWith(expect.objectContaining({ max: 10 }));
    });

    it('should use DATABASE_POOL_MAX when set (serverless sets 1)', async () => {
      // Arrange + Act — the serverless configuration: one connection per warm instance
      const { MockPool } = await importClientWithEnv({
        NODE_ENV: 'production',
        DATABASE_POOL_MAX: 1,
      });

      // Assert
      expect(MockPool).toHaveBeenCalledWith(expect.objectContaining({ max: 1 }));
    });

    it('should set both pool timeouts so exhaustion fails fast instead of hanging', async () => {
      // Arrange + Act
      const { MockPool } = await importClientWithEnv({ NODE_ENV: 'production' });

      // Assert — connectionTimeoutMillis is what turns "no free connection" into
      // an error the caller can log, rather than a request that hangs until the
      // platform kills it.
      expect(MockPool).toHaveBeenCalledWith(
        expect.objectContaining({
          idleTimeoutMillis: 10_000,
          connectionTimeoutMillis: 10_000,
        })
      );
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
    it('should cache the base prisma client on globalForPrisma in development', async () => {
      // Arrange + Act
      const { MockPrismaClient } = await importClientWithEnv({ NODE_ENV: 'development' });

      // Assert — the module wrote the BASE instance into globalThis (the
      // extension is applied fresh on every evaluation)
      const g = globalThis as unknown as { prisma?: unknown };
      expect(g.prisma).toBeDefined();
      expect(g.prisma).toBe(MockPrismaClient.mock.instances[0]);
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
      const { MockPrismaClient, mockWithTenancy } = await importClientWithEnv({
        NODE_ENV: 'development',
        preSeededGlobal: { prisma: cachedPrisma, pool: cachedPool },
      });

      // Assert — the cached base client was wrapped, not replaced
      expect(MockPrismaClient).not.toHaveBeenCalled();
      expect(mockWithTenancy).toHaveBeenCalledWith(cachedPrisma, expect.anything());
    });
  });

  describe('Tenancy seam (the chokepoint)', () => {
    it('exports the client withTenancy returns, wrapped around the constructed PrismaClient', async () => {
      // Arrange + Act
      const { prisma, MockPrismaClient, mockWithTenancy, mockContext } = await importClientWithEnv({
        NODE_ENV: 'development',
        TENANCY_MODE: 'single',
      });

      // Assert — the base client goes in, the extended client comes out, and
      // the extension reads the real context and mode, with the install org
      // as the single-tenant answer.
      const baseInstance = MockPrismaClient.mock.instances[0] as unknown;
      expect(mockWithTenancy).toHaveBeenCalledTimes(1);
      expect(mockWithTenancy).toHaveBeenCalledWith(baseInstance, {
        isMultiTenant: mockContext.isMultiTenant,
        getTenantContext: mockContext.getTenantContext,
        installOrgId: 'install',
      });
      expect(prisma).toBe(mockWithTenancy.mock.results[0].value);
    });

    it('no longer throws at import when TENANCY_MODE is multi — the extension scopes instead', async () => {
      // Arrange + Act
      const { prisma, MockPrismaClient, mockWithTenancy } = await importClientWithEnv({
        NODE_ENV: 'development',
        TENANCY_MODE: 'multi',
      });

      // Assert — same construction as single; the mode is read per operation
      // inside the extension, never at import.
      expect(prisma).toBeDefined();
      expect(MockPrismaClient).toHaveBeenCalledTimes(1);
      expect(mockWithTenancy).toHaveBeenCalledTimes(1);
    });

    it('applies the extension when TENANCY_MODE is undefined (single-tenant default)', async () => {
      // Arrange + Act — env without TENANCY_MODE (the default before anyone sets it)
      const { prisma, MockPrismaClient, mockWithTenancy } = await importClientWithEnv({
        NODE_ENV: 'development',
      });

      // Assert
      expect(prisma).toBeDefined();
      expect(MockPrismaClient).toHaveBeenCalledTimes(1);
      expect(mockWithTenancy).toHaveBeenCalledTimes(1);
    });

    it('re-wraps the cached BASE client on hot reload, so the extension reads the live context module', async () => {
      // Arrange — what survives a reload is the base client (it owns the pool)
      const cachedBase = { __type: 'CachedPrismaClient' };

      // Act
      const { prisma, MockPrismaClient, mockWithTenancy } = await importClientWithEnv({
        NODE_ENV: 'development',
        preSeededGlobal: { prisma: cachedBase, pool: { __type: 'CachedPool' } },
      });

      // Assert — no new base client, but a fresh extension over the cached
      // one: a retained extended client would close over the previous
      // evaluation's AsyncLocalStorage and see no context after a reload.
      expect(MockPrismaClient).not.toHaveBeenCalled();
      expect(mockWithTenancy).toHaveBeenCalledTimes(1);
      expect(mockWithTenancy.mock.calls[0][0]).toBe(cachedBase);
      expect(prisma).toBe(mockWithTenancy.mock.results[0].value);
      const g = globalThis as unknown as { prisma?: unknown };
      expect(g.prisma).toBe(cachedBase);
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
