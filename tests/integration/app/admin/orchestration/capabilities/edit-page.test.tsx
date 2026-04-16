/**
 * Integration Test: Admin Orchestration — Edit Capability Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/capabilities/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Mock serverFetch for capability GET + /capabilities/:id/agents in parallel
 * - Asserts edit form is pre-filled with fixture capability name
 * - Asserts notFound() is called when capability GET returns null
 *
 * @see app/admin/orchestration/capabilities/[id]/page.tsx
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

const MOCK_CAPABILITY = {
  id: 'cap-edit-id',
  name: 'Search Knowledge Base',
  slug: 'search-knowledge-base',
  description: 'Semantic search over the knowledge base',
  category: 'knowledge',
  executionType: 'internal',
  executionHandler: 'SearchKnowledgeCapability',
  executionConfig: null,
  functionDefinition: {},
  requiresApproval: false,
  rateLimit: null,
  isActive: true,
  createdBy: 'system',
  createdAt: new Date('2025-01-01').toISOString(),
  updatedAt: new Date('2025-01-01').toISOString(),
  deletedAt: null,
  metadata: {},
};

const MOCK_USED_BY = [{ id: 'agent-1', name: 'Alpha Bot', slug: 'alpha-bot' }];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditCapabilityPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders form pre-filled with capability name in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY }) // capability
      .mockResolvedValueOnce({ success: true, data: MOCK_USED_BY }) // usedBy
      .mockResolvedValueOnce({ success: true, data: [] }); // categories

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i });
      expect(nameInput.value).toBe('Search Knowledge Base');
    });
  });

  it('renders "Save changes" button in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug input pre-filled and disabled in edit mode', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse)
      .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: [] });

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      const slugInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^slug/i });
      expect(slugInput.value).toBe('search-knowledge-base');
      expect(slugInput).toBeDisabled();
    });
  });

  it('calls notFound() when capability fetch returns null', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: false,
      error: { message: 'Not found', code: 'NOT_FOUND' },
    });

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    await expect(
      EditCapabilityPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('usedBy / categories fallback branches', () => {
    it('renders when usedBy fetch rejects (network error on secondary fetch)', async () => {
      // Arrange: capability fetch succeeds; usedBy rejects; categories ok
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let callCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 2) throw new Error('Network error');
        return Promise.resolve({ ok: true } as Response);
      });
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY }) // capability
        .mockResolvedValueOnce({ success: true, data: [] }); // categories

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      // Act: should not throw — usedBy falls back to []
      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      // Assert: structural stability
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });
    });

    it('renders when usedBy fetch returns res.ok=false', async () => {
      // Arrange: capability ok, usedBy !ok, categories ok
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      let callCount = 0;
      vi.mocked(serverFetch).mockImplementation(() => {
        callCount++;
        if (callCount === 2) return Promise.resolve({ ok: false } as Response);
        return Promise.resolve({ ok: true } as Response);
      });
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
        .mockResolvedValueOnce({ success: true, data: [] }); // categories

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });
    });

    it('renders when categories parseApiResponse returns success=false', async () => {
      // Arrange: capability and usedBy succeed; categories parse fails
      const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
      vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
      vi.mocked(parseApiResponse)
        .mockResolvedValueOnce({ success: true, data: MOCK_CAPABILITY })
        .mockResolvedValueOnce({ success: true, data: MOCK_USED_BY })
        .mockResolvedValueOnce({
          success: false,
          error: { message: 'Parse failed', code: 'PARSE_ERROR' },
        });

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      // Page still renders with empty categories
      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });
    });
  });
});
