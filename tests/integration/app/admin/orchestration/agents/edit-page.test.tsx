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

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_AGENT })
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS })
      .mockResolvedValueOnce({ success: true, data: MOCK_MODELS });

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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_AGENT })
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS })
      .mockResolvedValueOnce({ success: true, data: MOCK_MODELS });

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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_AGENT })
      .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS })
      .mockResolvedValueOnce({ success: true, data: MOCK_MODELS });

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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });

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
    it('renders with null providers when provider fetch rejects', async () => {
      // Arrange: agent fetch succeeds; provider fetch rejects; model fetch succeeds
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let callCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('Network error');
        return Promise.resolve({ ok: true } as Response);
      });
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_AGENT }) // agent
        .mockResolvedValueOnce({ success: true, data: MOCK_MODELS }); // models

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      // Act: should not throw
      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      // Assert: page still renders its structural heading (graceful degradation)
      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });

    it('renders with null providers when provider fetch returns res.ok=false', async () => {
      // Arrange: agent ok, provider not ok, model ok
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let callCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.resolve({ ok: false } as Response);
        return Promise.resolve({ ok: true } as Response);
      });
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_AGENT }) // agent
        .mockResolvedValueOnce({ success: true, data: MOCK_MODELS }); // models (provider skips parseApiResponse)

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });

    it('renders with null models when model parseApiResponse returns success=false', async () => {
      // Arrange: agent and provider succeed; model parseApiResponse returns failure
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_AGENT })
        .mockResolvedValueOnce({ success: true, data: MOCK_PROVIDERS })
        .mockResolvedValueOnce({
          success: false,
          error: { message: 'Registry unavailable', code: 'SERVICE_ERROR' },
        });

      const { default: EditAgentPage } = await import('@/app/admin/orchestration/agents/[id]/page');

      render(await EditAgentPage({ params: Promise.resolve({ id: 'agent-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /my edit agent/i })).toBeInTheDocument();
      });
    });
  });
});
