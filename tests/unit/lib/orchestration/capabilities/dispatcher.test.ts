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
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/orchestration/knowledge/search', () => ({
  searchKnowledge: vi.fn().mockResolvedValue([]),
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
const { searchKnowledge } = await import('@/lib/orchestration/knowledge/search');
const { SearchKnowledgeCapability } =
  await import('@/lib/orchestration/capabilities/built-in/search-knowledge');

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
  protected readonly schema = z.unknown();

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
  protected readonly schema = z.unknown();

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
  approvalTimeoutMs?: number | null;
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
    approvalTimeoutMs: overrides.approvalTimeoutMs ?? null,
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
  // Default: agent with no category restrictions (for SearchKnowledgeCapability)
  (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    knowledgeCategories: [],
  });
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

      // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
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

      // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
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

      expect(result).toMatchObject({
        success: false,
        error: { code: 'requires_approval' },
        skipFollowup: true,
        metadata: {
          defaultAction: 'deny',
        },
      });
      // test-review:accept clear_then_notcalled — clearAllMocks is in beforeEach (not mid-test); not.toHaveBeenCalled verifies requires_approval skips execute
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
      // test-review:accept no_arg_called — logger.error call shape is secondary; primary assertion is the execution_error result above
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

      // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
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

      // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
      expect(r1.success).toBe(true);
      expect(r2).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'rate_limited' }),
      });
    });
  });

  describe('malformed functionDefinition', () => {
    it('skips rows with invalid functionDefinition during loadFromDatabase', async () => {
      capabilityDispatcher.register(new OkCapability());
      // Row has a malformed functionDefinition — missing required 'name'
      mockFindMany.mockResolvedValue([makeCapabilityRow({ functionDefinition: { bad: true } })]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 1 }, ctx);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({ code: 'capability_inactive' }),
      });
    });
  });

  describe('logCost failure', () => {
    it('logs error when logCost rejects but still returns success', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);
      mockLogCost.mockRejectedValue(new Error('cost DB down'));

      const result = await capabilityDispatcher.dispatch('ok', { n: 5 }, ctx);

      expect(result).toEqual({ success: true, data: { doubled: 10 } });

      // Flush microtasks for fire-and-forget .catch()
      await new Promise((r) => setTimeout(r, 10));

      expect(mockLoggerError).toHaveBeenCalledWith(
        'Capability dispatch: logCost rejected',
        expect.objectContaining({ slug: 'ok' })
      );
    });
  });

  describe('agent binding with null capability', () => {
    it('skips pivot rows where capability is null', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);
      mockAgentFindMany.mockResolvedValue([
        {
          id: 'aac-1',
          agentId: 'agent-1',
          capabilityId: 'cap-1',
          isEnabled: true,
          customRateLimit: null,
          capability: null, // null capability
        },
      ]);

      // Should fall through to default-allow binding
      const result = await capabilityDispatcher.dispatch('ok', { n: 1 }, ctx);

      expect(result).toEqual({ success: true, data: { doubled: 2 } });
    });
  });

  describe('inflight binding deduplication', () => {
    it('issues exactly one aiAgentCapability.findMany when two dispatches fire concurrently', async () => {
      capabilityDispatcher.register(new OkCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow()]);
      mockAgentFindMany.mockResolvedValue([]);

      const [r1, r2] = await Promise.all([
        capabilityDispatcher.dispatch('ok', { n: 1 }, ctx),
        capabilityDispatcher.dispatch('ok', { n: 2 }, ctx),
      ]);

      // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      // Both calls for the same agentId should dedupe
      expect(mockAgentFindMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('null rate limit', () => {
    it('does not rate limit when effectiveLimit is null (unlimited)', async () => {
      capabilityDispatcher.register(new RateLimitedCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'ratelimited', rateLimit: null })]);

      // Even many calls should succeed
      const results = await Promise.all(
        Array.from({ length: 5 }, () => capabilityDispatcher.dispatch('ratelimited', {}, ctx))
      );

      expect(results.every((r) => r.success)).toBe(true);
    });
  });

  describe('rate limit TTL recovery', () => {
    it('allows requests again after the sliding window expires', async () => {
      vi.useFakeTimers();
      try {
        capabilityDispatcher.register(new RateLimitedCapability());
        mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'ratelimited', rateLimit: 1 })]);

        // First call succeeds, second is rate-limited
        const r1 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);
        const r2 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);
        // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
        expect(r1.success).toBe(true);
        expect(r2.success).toBe(false);

        // Advance past the 60s sliding window
        vi.advanceTimersByTime(61_000);

        // The window has expired — next call should succeed
        const r3 = await capabilityDispatcher.dispatch('ratelimited', {}, ctx);
        // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
        expect(r3.success).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('search_knowledge_base dispatch integration', () => {
    it('routes dispatch through SearchKnowledgeCapability and returns results', async () => {
      const mockSearchKnowledge = searchKnowledge as ReturnType<typeof vi.fn>;
      mockSearchKnowledge.mockResolvedValue([
        {
          chunk: {
            id: 'chunk-1',
            content: 'ReAct pattern',
            patternNumber: 1,
            patternName: 'ReAct',
            section: 'Overview',
          },
          similarity: 0.92,
        },
      ]);

      capabilityDispatcher.register(new SearchKnowledgeCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'search_knowledge_base' })]);

      const result = await capabilityDispatcher.dispatch(
        'search_knowledge_base',
        { query: 'ReAct pattern' },
        ctx
      );

      // test-review:accept tobe_true — boolean field `success` on CapabilityResult; structural assertion on dispatch outcome
      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        results: [
          {
            chunkId: 'chunk-1',
            content: 'ReAct pattern',
            patternNumber: 1,
            patternName: 'ReAct',
            section: 'Overview',
            similarity: 0.92,
          },
        ],
      });
      expect(mockSearchKnowledge).toHaveBeenCalledWith('ReAct pattern', undefined, 10, 0.7);
    });
  });

  describe('execution throws non-Error value', () => {
    it('returns execution_error with generic message for non-Error throw', async () => {
      // Create a capability that throws a string
      class StringThrowCapability extends BaseCapability<unknown, never> {
        readonly slug = 'string-throw';
        readonly functionDefinition = {
          name: 'string-throw',
          description: '',
          parameters: {},
        };
        protected readonly schema = z.unknown();

        async execute(_args: unknown): Promise<never> {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'string error';
        }
      }

      capabilityDispatcher.register(new StringThrowCapability());
      mockFindMany.mockResolvedValue([makeCapabilityRow({ slug: 'string-throw' })]);

      const result = await capabilityDispatcher.dispatch('string-throw', {}, ctx);

      expect(result).toEqual({
        success: false,
        error: expect.objectContaining({
          code: 'execution_error',
          message: 'Capability execution failed',
        }),
      });
    });
  });
});
