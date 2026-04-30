/**
 * Tests for the capability registry: idempotent built-in registration
 * and `getCapabilityDefinitions` filtering.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    aiAgentCapability: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { capabilityDispatcher } = await import('@/lib/orchestration/capabilities/dispatcher');
const { registerBuiltInCapabilities, getCapabilityDefinitions, __resetRegistrationForTests } =
  await import('@/lib/orchestration/capabilities/registry');

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  __resetRegistrationForTests();
  // Reinstall the default empty resolution (cleared by clearAllMocks).
  (prisma.aiCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe('registerBuiltInCapabilities', () => {
  it('registers every built-in on first call', () => {
    registerBuiltInCapabilities();
    expect(capabilityDispatcher.has('search_knowledge_base')).toBe(true);
    expect(capabilityDispatcher.has('get_pattern_detail')).toBe(true);
    expect(capabilityDispatcher.has('estimate_workflow_cost')).toBe(true);
    expect(capabilityDispatcher.has('read_user_memory')).toBe(true);
    expect(capabilityDispatcher.has('write_user_memory')).toBe(true);
    expect(capabilityDispatcher.has('escalate_to_human')).toBe(true);
    expect(capabilityDispatcher.has('apply_audit_changes')).toBe(true);
    expect(capabilityDispatcher.has('add_provider_models')).toBe(true);
  });

  it('is idempotent (second call is a no-op)', () => {
    const spy = vi.spyOn(capabilityDispatcher, 'register');
    registerBuiltInCapabilities();
    registerBuiltInCapabilities();
    expect(spy).toHaveBeenCalledTimes(8); // only from the first call
    spy.mockRestore();
  });
});

describe('getCapabilityDefinitions', () => {
  it('returns only definitions enabled for the agent and registered in memory', async () => {
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-1',
        agentId: 'agent-1',
        capabilityId: 'cap-1',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-1',
          slug: 'search_knowledge_base',
          name: 'Search Knowledge',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'search_knowledge_base',
            description: 'Search',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
      {
        id: 'aac-2',
        agentId: 'agent-1',
        capabilityId: 'cap-2',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-2',
          slug: 'not_implemented',
          name: 'Unimplemented',
          category: 'other',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'not_implemented',
            description: 'Nope',
            parameters: {},
          },
        },
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('search_knowledge_base');
  });

  it('returns an empty list when the agent has no pivot rows', async () => {
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const defs = await getCapabilityDefinitions('agent-empty');
    expect(defs).toEqual([]);
  });

  it('skips rows where the capability relation is null', async () => {
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-null',
        agentId: 'agent-1',
        capabilityId: 'cap-gone',
        isEnabled: true,
        customRateLimit: null,
        capability: null, // edge case — deleted between query plan and execution
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toEqual([]);
  });

  it('warns and skips capabilities with malformed functionDefinition JSON', async () => {
    const { logger } = await import('@/lib/logging');

    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-bad',
        agentId: 'agent-1',
        capabilityId: 'cap-bad',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-bad',
          slug: 'search_knowledge_base',
          name: 'Bad Def',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: { description: 'Missing name field' }, // invalid — `name` is required
        },
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed functionDefinition'),
      expect.objectContaining({ slug: 'search_knowledge_base' })
    );
  });

  it('matches on capability slug, not function definition name', async () => {
    // Capability slug matches a registered handler, but the function definition
    // name is different — should still be included because we check slug.
    (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'aac-3',
        agentId: 'agent-1',
        capabilityId: 'cap-3',
        isEnabled: true,
        customRateLimit: null,
        capability: {
          id: 'cap-3',
          slug: 'search_knowledge_base', // matches registered handler
          name: 'Custom KB Search',
          category: 'knowledge',
          isActive: true,
          requiresApproval: false,
          rateLimit: null,
          functionDefinition: {
            name: 'custom_kb_search', // different from slug
            description: 'Search with custom name',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    ]);

    const defs = await getCapabilityDefinitions('agent-1');
    expect(defs).toHaveLength(1);
    expect(defs[0]?.name).toBe('custom_kb_search');
  });
});
