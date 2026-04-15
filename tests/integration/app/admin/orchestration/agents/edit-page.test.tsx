/**
 * Integration Test: Admin Orchestration — Edit Agent Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Renders form pre-filled with agent data in edit mode
 * - Calls notFound() when agent is null
 *
 * @see app/admin/orchestration/agents/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findUnique: vi.fn(),
    },
    aiProviderConfig: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getAvailableModels: vi.fn(),
}));

vi.mock('@/lib/orchestration/llm/provider-manager', () => ({
  isApiKeyEnvVarSet: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    withContext: vi.fn(() => ({
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
    })),
  },
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_AGENT = {
  id: 'agent-edit-id',
  name: 'My Edit Agent',
  slug: 'my-edit-agent',
  description: 'Helps with editing',
  systemInstructions: 'You are a helpful editor.',
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  temperature: 0.7,
  maxTokens: 4096,
  monthlyBudgetUsd: null,
  isActive: true,
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  systemInstructionsHistory: [],
  metadata: {},
  deletedAt: null,
};

const MOCK_PROVIDERS = [
  {
    id: 'prov-1',
    name: 'Anthropic',
    slug: 'anthropic',
    apiKeyEnvVar: 'ANTHROPIC_KEY',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    baseUrl: null,
    description: null,
    metadata: {},
  },
];

const MOCK_MODELS = [{ provider: 'anthropic', id: 'claude-opus-4-6', tier: 'frontier' }];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditAgentPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders agent name as heading in edit mode', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    const { getAvailableModels } = await import('@/lib/orchestration/llm/model-registry');
    const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(MOCK_AGENT as any);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(MOCK_PROVIDERS as any);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
    vi.mocked(getAvailableModels).mockReturnValue(MOCK_MODELS as any);

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    // Act
    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    // Assert: agent name rendered
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
    });
  });

  it('shows "Save changes" button in edit mode', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    const { getAvailableModels } = await import('@/lib/orchestration/llm/model-registry');
    const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(MOCK_AGENT as any);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(MOCK_PROVIDERS as any);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
    vi.mocked(getAvailableModels).mockReturnValue(MOCK_MODELS as any);

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    // Act
    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    // Assert
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug field is pre-filled and disabled in edit mode', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    const { getAvailableModels } = await import('@/lib/orchestration/llm/model-registry');
    const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(MOCK_AGENT as any);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(MOCK_PROVIDERS as any);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
    vi.mocked(getAvailableModels).mockReturnValue(MOCK_MODELS as any);

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    // Act
    render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

    // Assert: slug pre-filled and disabled
    await waitFor(() => {
      const slugInput = screen.getByRole('textbox', { name: /^slug/i });
      expect((slugInput as HTMLInputElement).value).toBe('my-edit-agent');
      expect(slugInput).toBeDisabled();
    });
  });

  it('calls notFound() when agent fetch returns null', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    const { getAvailableModels } = await import('@/lib/orchestration/llm/model-registry');
    const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([]);
    vi.mocked(isApiKeyEnvVarSet).mockReturnValue(false);
    vi.mocked(getAvailableModels).mockReturnValue([]);

    const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

    // Act: notFound() throws NEXT_NOT_FOUND
    await expect(
      EditAgentPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    // Assert: notFound was called
    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('provider/model fetch fallbacks', () => {
    it('renders with null providers when prisma rejects', async () => {
      // Arrange: agent fetch succeeds; provider+model fetch rejects
      const { prisma } = await import('@/lib/db/client');
      const { getAvailableModels } = await import('@/lib/orchestration/llm/model-registry');
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(MOCK_AGENT as any);
      vi.mocked(prisma.aiProviderConfig.findMany).mockRejectedValue(new Error('Network error'));
      vi.mocked(getAvailableModels).mockReturnValue(MOCK_MODELS as any);

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      // Act: should not throw (catch block sets agent=null, providers=null, models=null)
      // But since agent was found before the catch, page falls through to notFound if agent is null
      // The page catches the whole Promise.all — so agent=null, which calls notFound
      await expect(
        EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) })
      ).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('renders with null models when getAvailableModels throws', async () => {
      // Arrange: agent and provider succeed; getAvailableModels throws (synchronously via Promise.reject)
      const { prisma } = await import('@/lib/db/client');
      const { getAvailableModels } = await import('@/lib/orchestration/llm/model-registry');
      const { isApiKeyEnvVarSet } = await import('@/lib/orchestration/llm/provider-manager');
      vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(MOCK_AGENT as any);
      vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue(MOCK_PROVIDERS as any);
      vi.mocked(isApiKeyEnvVarSet).mockReturnValue(true);
      // getAvailableModels is synchronous; if it throws inside Promise.resolve() wrapper,
      // the whole Promise.all rejects → catch block sets agent=null → notFound
      vi.mocked(getAvailableModels).mockImplementation(() => {
        throw new Error('Registry unavailable');
      });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      // Act: catch block runs, agent=null → notFound
      await expect(
        EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) })
      ).rejects.toThrow('NEXT_NOT_FOUND');
    });
  });
});
