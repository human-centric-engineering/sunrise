/**
 * Unit Tests: lib/orchestration/llm/agent-resolver
 *
 * Test Coverage:
 * - resolveAgentProviderAndModel: explicit provider + model pass through unchanged
 * - resolveAgentProviderAndModel: empty agent.provider + model fall back to first
 *   active provider with key set + system default-chat model
 * - resolveAgentProviderAndModel: throws NoProviderConfiguredError when no
 *   active provider has a reachable key
 * - resolveAgentProviderAndModel: only one of provider/model empty — fills the
 *   missing side and keeps the explicit side
 * - resolveAgentProviderAndModel: agent's explicit fallbackProviders win even
 *   when the primary provider is filled by the resolver
 * - resolveAgentProviderAndModel: empty fallbackProviders + empty primary →
 *   resolver attaches up to 3 system fallbacks, excluding the chosen primary
 *
 * @see lib/orchestration/llm/agent-resolver.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn((envVar: string | null) => {
    if (!envVar) return false;
    return envVar === 'PRESENT_KEY' || envVar === 'OTHER_PRESENT_KEY';
  }),
}));

vi.mock('@/lib/orchestration/llm/settings-resolver', () => ({
  getDefaultModelForTask: vi.fn(async (task: string) => {
    return task === 'chat' ? 'system-chat-model' : `system-${task}-model`;
  }),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import {
  resolveAgentProviderAndModel,
  NoProviderConfiguredError,
  type ResolvableAgent,
} from '@/lib/orchestration/llm/agent-resolver';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

interface FakeProviderRow {
  slug: string;
  apiKeyEnvVar: string | null;
  isLocal: boolean;
  isActive: boolean;
  createdAt: Date;
}

function makeProviderRow(overrides: Partial<FakeProviderRow> = {}): FakeProviderRow {
  return {
    slug: 'anthropic',
    apiKeyEnvVar: 'PRESENT_KEY',
    isLocal: false,
    isActive: true,
    createdAt: new Date('2026-04-15T00:00:00Z'),
    ...overrides,
  };
}

function makeAgent(overrides: Partial<ResolvableAgent> = {}): ResolvableAgent {
  return {
    provider: '',
    model: '',
    fallbackProviders: [],
    ...overrides,
  };
}

function setProviders(rows: FakeProviderRow[]): void {
  vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(rows as never);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('resolveAgentProviderAndModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('explicit values pass through', () => {
    it('returns agent.provider + agent.model unchanged when both are set', async () => {
      const agent = makeAgent({
        provider: 'openai',
        model: 'gpt-4o-mini',
        fallbackProviders: ['anthropic'],
      });

      const result = await resolveAgentProviderAndModel(agent, 'chat');

      expect(result).toEqual({
        providerSlug: 'openai',
        model: 'gpt-4o-mini',
        fallbacks: ['anthropic'],
      });
      expect(prisma.aiProviderConfig.findMany).not.toHaveBeenCalled();
    });
  });

  describe('empty primary binding', () => {
    it('falls back to the first active provider whose env key is set', async () => {
      setProviders([
        makeProviderRow({ slug: 'openai', apiKeyEnvVar: 'MISSING_KEY' }),
        makeProviderRow({
          slug: 'anthropic',
          apiKeyEnvVar: 'PRESENT_KEY',
          createdAt: new Date('2026-04-16T00:00:00Z'),
        }),
      ]);

      const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

      expect(result.providerSlug).toBe('anthropic');
      expect(result.model).toBe('system-chat-model');
    });

    it('treats isLocal providers as reachable without an env key', async () => {
      setProviders([makeProviderRow({ slug: 'ollama-local', apiKeyEnvVar: null, isLocal: true })]);

      const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

      expect(result.providerSlug).toBe('ollama-local');
      expect(result.model).toBe('system-chat-model');
    });

    it('throws NoProviderConfiguredError when no provider has a reachable key', async () => {
      setProviders([
        makeProviderRow({ slug: 'openai', apiKeyEnvVar: 'MISSING_KEY' }),
        makeProviderRow({ slug: 'anthropic', apiKeyEnvVar: 'ALSO_MISSING' }),
      ]);

      await expect(resolveAgentProviderAndModel(makeAgent(), 'chat')).rejects.toBeInstanceOf(
        NoProviderConfiguredError
      );
    });

    it('skips inactive providers even if their key is set', async () => {
      // findMany is filtered by isActive: true, so an inactive row never
      // reaches the resolver. Verify the where clause includes isActive.
      setProviders([]);

      await expect(resolveAgentProviderAndModel(makeAgent(), 'chat')).rejects.toBeInstanceOf(
        NoProviderConfiguredError
      );

      expect(prisma.aiProviderConfig.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isActive: true } })
      );
    });
  });

  describe('partial bindings', () => {
    it('keeps explicit provider and fills empty model from system defaults', async () => {
      setProviders([makeProviderRow()]);

      const result = await resolveAgentProviderAndModel(
        makeAgent({ provider: 'openai', model: '' }),
        'chat'
      );

      expect(result.providerSlug).toBe('openai');
      expect(result.model).toBe('system-chat-model');
    });

    it('keeps explicit model and fills empty provider from active candidates', async () => {
      setProviders([makeProviderRow({ slug: 'anthropic' })]);

      const result = await resolveAgentProviderAndModel(
        makeAgent({ provider: '', model: 'claude-opus-4-6' }),
        'chat'
      );

      expect(result.providerSlug).toBe('anthropic');
      expect(result.model).toBe('claude-opus-4-6');
    });
  });

  describe('fallback list behaviour', () => {
    it('uses the agent fallbackProviders when explicitly set', async () => {
      setProviders([makeProviderRow({ slug: 'anthropic' })]);

      const result = await resolveAgentProviderAndModel(
        makeAgent({ fallbackProviders: ['custom-fallback'] }),
        'chat'
      );

      expect(result.fallbacks).toEqual(['custom-fallback']);
    });

    it('attaches up to 3 system fallbacks when the agent fallback list is empty', async () => {
      const rows = [
        makeProviderRow({ slug: 'anthropic', apiKeyEnvVar: 'PRESENT_KEY' }),
        makeProviderRow({
          slug: 'openai',
          apiKeyEnvVar: 'OTHER_PRESENT_KEY',
          createdAt: new Date('2026-04-16T00:00:00Z'),
        }),
        makeProviderRow({
          slug: 'ollama-local',
          apiKeyEnvVar: null,
          isLocal: true,
          createdAt: new Date('2026-04-17T00:00:00Z'),
        }),
      ];
      setProviders(rows);

      const result = await resolveAgentProviderAndModel(makeAgent(), 'chat');

      expect(result.providerSlug).toBe('anthropic');
      expect(result.fallbacks).toEqual(['openai', 'ollama-local']);
    });
  });
});
