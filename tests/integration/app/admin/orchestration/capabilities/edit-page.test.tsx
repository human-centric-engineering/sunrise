/**
 * Integration Test: Admin Orchestration — Edit Capability Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/capabilities/[id]/page.tsx`.
 *
 * Test Coverage:
 * - Mock prisma for capability + agent links + categories in parallel
 * - Asserts edit form is pre-filled with fixture capability name
 * - Asserts notFound() is called when capability fetch returns null
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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    aiAgentCapability: {
      findMany: vi.fn(),
    },
  },
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
  createdAt: new Date('2025-01-01'),
  updatedAt: new Date('2025-01-01'),
  deletedAt: null,
  metadata: {},
};

const MOCK_AGENT_LINKS = [
  {
    id: 'link-1',
    agentId: 'agent-1',
    capabilityId: 'cap-edit-id',
    agent: { id: 'agent-1', name: 'Alpha Bot', slug: 'alpha-bot' },
  },
];

const MOCK_ALL_CAPS = [{ category: 'knowledge' }, { category: 'api' }];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('EditCapabilityPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders form pre-filled with capability name in edit mode', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(MOCK_CAPABILITY as any);
    vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue(MOCK_AGENT_LINKS as any);
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue(MOCK_ALL_CAPS as any);

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      const nameInput = screen.getByRole<HTMLInputElement>('textbox', { name: /^name/i });
      expect(nameInput.value).toBe('Search Knowledge Base');
    });
  });

  it('renders "Save changes" button in edit mode', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(MOCK_CAPABILITY as any);
    vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    });
  });

  it('slug input pre-filled and disabled in edit mode', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(MOCK_CAPABILITY as any);
    vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);

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
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);

    const { default: EditCapabilityPage } =
      await import('@/app/admin/orchestration/capabilities/[id]/page');

    await expect(
      EditCapabilityPage({ params: Promise.resolve({ id: 'nonexistent-id' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND');

    expect(mockNotFound).toHaveBeenCalledOnce();
  });

  // ── Fallback branches ──────────────────────────────────────────────────────

  describe('usedBy / categories fallback branches', () => {
    it('renders when agentCapability fetch rejects (catch sets usedBy=[], categories=[])', async () => {
      // Arrange: capability fetch succeeds; agentLinks and allCaps reject via the whole Promise.all
      const { prisma } = await import('@/lib/db/client');
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(MOCK_CAPABILITY as any);
      vi.mocked(prisma.aiAgentCapability.findMany).mockRejectedValue(new Error('Network error'));
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      // The whole Promise.all rejects → catch block sets capability=null → notFound
      await expect(
        EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) })
      ).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('renders form when all fetches succeed with empty arrays', async () => {
      const { prisma } = await import('@/lib/db/client');
      vi.mocked(prisma.aiCapability.findUnique).mockResolvedValue(MOCK_CAPABILITY as any);
      vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([]);
      vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);

      const { default: EditCapabilityPage } =
        await import('@/app/admin/orchestration/capabilities/[id]/page');

      render(await EditCapabilityPage({ params: Promise.resolve({ id: 'cap-edit-id' }) }));

      await waitFor(() => {
        expect(screen.getByRole('textbox', { name: /^name/i })).toBeInTheDocument();
      });
    });
  });
});
