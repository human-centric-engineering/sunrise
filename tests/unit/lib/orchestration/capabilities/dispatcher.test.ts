/**
 * Tests for CapabilityDispatcher: DB registry loading, per-agent bindings,
 * rate limiting, approval gating, arg validation, execution, and cost logging.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before any dynamic imports
// ---------------------------------------------------------------------------

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: { findMany: vi.fn() },
    aiAgentCapability: { findMany: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (after mocks are in place)
// ---------------------------------------------------------------------------

const { prisma } = await import('@/lib/db/client');
const { logger } = await import('@/lib/logging');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const { BaseCapability } = await import('@/lib/orchestration/capabilities/base-capability');
const { CostOperation } = await import('@/types/orchestration');

// ---------------------------------------------------------------------------
// Inline test capability subclasses
// ---------------------------------------------------------------------------

class OkCapability extends BaseCapability<{ n: number }, { doubled: number }> {
  readonly slug = 'ok';
  readonly functionDefinition = { name: 'ok', description: '', parameters: {} };
  protected readonly schema = z.object({ n: z.number() });

  async execute(args: { n: number }) {
    return this.success({ doubled: args.n * 2 });
  }
}

class ThrowingCapability extends BaseCapability<unknown, never> {
  readonly slug = 'throws';
  readonly functionDefinition = {
    name: 'throws',
    description: '',
    parameters: {},
  };
  protected readonly schema = undefined;

  async execute(_args: unknown): Promise<never> {
    throw new Error('boom');
  }
}

class RateLimitedCapability extends BaseCapability<unknown, { ok: true }> {
  readonly slug = 'ratelimited';
  readonly functionDefinition = {
    name: 'ratelimited',
    description: '',
    parameters: {},
  };
  protected readonly schema = undefined;

  async execute(_args: unknown) {
    return this.success({ ok: true as const });
  }
}

// ---------------------------------------------------------------------------
// Helper — build a minimal AiCapability DB row with sensible defaults
// ---------------------------------------------------------------------------

interface CapabilityRowOverrides {
  id?: string;
  slug?: string;
  name?: string;
  category?: string;
  functionDefinition?: Record<string, unknown>;
  requiresApproval?: boolean;
  rateLimit?: number | null;
  isActive?: boolean;
}

function makeCapabilityRow(overrides: CapabilityRowOverrides = {}) {
  const slug = overrides.slug ?? 'ok';
  return {
    id: overrides.id ?? 'cap-1',
    slug,
    name: overrides.name ?? slug,
    category: overrides.category ?? 'test',
    functionDefinition: overrides.functionDefinition ?? {
      name: slug,
      description: '',
      parameters: {},
    },
    requiresApproval: overrides.requiresApproval ?? false,
    rateLimit: overrides.rateLimit !== undefined ? overrides.rateLimit : null,
    isActive: overrides.isActive ?? true,
  };
}

// ---------------------------------------------------------------------------
// Default context used throughout
// ---------------------------------------------------------------------------

const ctx = { userId: 'user-1', agentId: 'agent-1', conversationId: 'conv-1' };

// ---------------------------------------------------------------------------
// Typed mock aliases
// ---------------------------------------------------------------------------

const mockFindMany = prisma.aiCapability.findMany as ReturnType<typeof vi.fn>;
const mockAgentFindMany = prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>;
const mockLogCost = logCost as ReturnType<typeof vi.fn>;
const mockLoggerError = logger.error as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  // Default: no explicit pivot rows → default-allow
  mockAgentFindMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CapabilityDispatcher', () => {
  describe('unknown slug', () => {
    it('returns unknown_capability when slug has no registered handler', async () => {
      mockFindMany.mockResolvedValue([]);

      const result = await capabilityDispatcher.dispatch('does_not_exist', {}, ctx);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'unknown_capability' }),
      });
    });

    it('never calls findMany more than once for handler lookup failure', async () => {
      mockFindMany.mockResolvedValue([]);

      await capabilityDispatcher.dispatch('missing', {}, ctx);

      // loadFromDatabase is called but handler lookup short-circuits before
      // any further DB interaction — findMany still fires exactly once.
      expect(mockFindMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('inactive capability', () => {
    it('returns capability_inactive when handler is registered but DB row is absent', async () => {
      capabilityDispatcher.register(new OkCapability());
      // No row in DB → capability is inactive
      mockFindMany.mockResolvedValue([]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 1 }, ctx);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'capability_inactive' }),
      });
    });
  });

  describe('disabled for agent', () => {
    it('returns capability_disabled_for_agent when pivot row has isEnabled=false', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);
      mockAgentFindMany.mockResolvedValue([
        {
          id: 'aac-1',
          agentId: 'agent-1',
          capabilityId: 'cap-1',
          isEnabled: false,
          customRateLimit: null,
          capability: {
            id: 'cap-1',
            slug: 'ok',
            name: 'ok',
            category: 'test',
            isActive: true,
            requiresApproval: false,
            rateLimit: null,
            functionDefinition: { name: 'ok', description: '', parameters: {} },
          },
        },
      ]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 1 }, ctx);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'capability_disabled_for_agent' }),
      });
    });
  });

  describe('rate limiting', () => {
    it('returns rate_limited on the third call when rateLimit=2', async () => {
      capabilityDispatcher.register(new RateLimitedCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'ratelimited', rateLimit: 2 })]);

      const r1 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);
      const r2 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);
      const r3 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'rate_limited' }),
      });
    });

    it('rate limit is isolated per agentId — agentB is unaffected when agentA hits limit', async () => {
      capabilityDispatcher.register(new RateLimitedCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'ratelimited', rateLimit: 1 })]);

      const ctxA = { userId: 'u-a', agentId: 'agent-a' };
      const ctxB = { userId: 'u-b', agentId: 'agent-b' };

      // agentA hits the limit on first call already (maxRequests=1, so second call fails)
      const a1 = await capabilityDispatcher.dispatch('ratelimited', {}, ctxA);
      const a2 = await capabilityDispatcher.dispatch('ratelimited', {}, ctxA);

      // agentB should still succeed on its first call
      const b1 = await capabilityDispatcher.dispatch('ratelimited', {}, ctxB);

      expect(a1.success).toBe(true);
      expect(a2).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'rate_limited' }),
      });
      expect(b1.success).toBe(true);
    });
  });

  describe('requires approval', () => {
    it('returns requires_approval with skipFollowup=true and never calls execute', async () => {
      const executeSpy = vi.spyOn(OkCapability.prototype, 'execute');
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow({ requiresApproval: true })]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 1 }, ctx);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'requires_approval' }),
        skipFollowup: true,
      });
      expect(executeSpy).not.toHaveBeenCalled();
      executeSpy.mockRestore();
    });
  });

  describe('invalid args', () => {
    it('returns invalid_args with a non-empty message when schema validation fails', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);

      const result = await capabilityDispatcher.dispatch(
        'ok',
        { n: 'not-a-number' }, // schema expects z.number()
        ctx
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_args');
      expect(result.error?.message.length).toBeGreaterThan(0);
    });
  });

  describe('handler throws', () => {
    it('returns execution_error and calls logger.error when execute throws', async () => {
      capabilityDispatcher.register(new ThrowingCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'throws' })]);

      const result = await capabilityDispatcher.dispatch('throws', {}, ctx);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'execution_error' }),
      });
      expect(mockLoggerError).toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('returns handler result verbatim and calls logCost with correct args', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);
      mockLogCost.mockResolvedValue(null);

      const result = await capabilityDispatcher.dispatch('ok', { n: 5 }, ctx);

      // Handler result is returned as-is
      expect(result).toEqual({ success: true, data: { doubled: 10 } });

      // Flush microtasks so the fire-and-forget logCost Promise resolves
      await Promise.resolve();
      await Promise.resolve();

      expect(mockLogCost).toHaveBeenCalledTimes(1);
      expect(mockLogCost).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: CostOperation.TOOL_CALL,
          model: 'n/a',
          provider: 'capability',
          inputTokens: 0,
          outputTokens: 0,
          metadata: { slug: 'ok', success: true },
        })
      );
    });

    it('passes validated args and full context to execute', async () => {
      const executeSpy = vi.spyOn(OkCapability.prototype, 'execute');
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);

      await capabilityDispatcher.dispatch('ok', { n: 7 }, ctx);

      expect(executeSpy).toHaveBeenCalledWith({ n: 7 }, ctx);
      executeSpy.mockRestore();
    });
  });

  describe('loadFromDatabase deduplication', () => {
    it('issues exactly one findMany call when two dispatches fire concurrently', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);

      // Dispatch two calls simultaneously without awaiting the first
      const [r1, r2] = await Promise.all([
        capabilityDispatcher.dispatch('ok', { n: 1 }, ctx),
        capabilityDispatcher.dispatch('ok', { n: 2 }, ctx),
      ]);

      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(mockFindMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('clearCache forces refetch', () => {
    it('calls findMany again after clearCache()', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);

      // First dispatch populates the cache
      await capabilityDispatcher.dispatch('ok', { n: 1 }, ctx);
      expect(mockFindMany).toHaveBeenCalledTimes(1);

      // Clear cache and dispatch again
      capabilityDispatcher.clearCache();
      await capabilityDispatcher.dispatch('ok', { n: 2 }, ctx);

      expect(mockFindMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('customRateLimit override', () => {
    it('uses pivot customRateLimit instead of base rateLimit', async () => {
      capabilityDispatcher.register(new RateLimitedCapability());
      // Base capability has a generous rateLimit: 99
      mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'ratelimited', rateLimit: 99 })]);
      // Pivot row overrides with customRateLimit: 1
      mockAgentFindMany.mockResolvedValue([
        {
          id: 'aac-1',
          agentId: 'agent-1',
          capabilityId: 'cap-1',
          isEnabled: true,
          customRateLimit: 1,
          capability: {
            id: 'cap-1',
            slug: 'ratelimited',
            name: 'ratelimited',
            category: 'test',
            isActive: true,
            requiresApproval: false,
            rateLimit: 99,
            functionDefinition: {
              name: 'ratelimited',
              description: '',
              parameters: {},
            },
          },
        },
      ]);

      const r1 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);
      const r2 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);

      expect(r1.success).toBe(true);
      expect(r2).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'rate_limited' }),
      });
    });
  });
});
