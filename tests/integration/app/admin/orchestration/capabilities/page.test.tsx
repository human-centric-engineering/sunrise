/**
 * Integration Test: Admin Orchestration — Capabilities List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/capabilities/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid prisma response
 * - Renders table rows from pre-fetched data
 * - "+ New Capability" link present
 * - Empty state when prisma returns empty array
 * - Graceful no-throw when prisma rejects
 *
 * @see app/admin/orchestration/capabilities/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: {
      findMany: vi.fn(),
      count: vi.fn(),
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

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
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

function makeCapability(id: string, name: string, category = 'api') {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    description: 'A test capability',
    category,
    executionType: 'api',
    executionHandler: 'https://example.com/handler',
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
}

const MOCK_CAPABILITIES = [
  makeCapability('cap-1', 'Search Knowledge', 'knowledge'),
  makeCapability('cap-2', 'Send Email', 'api'),
  makeCapability('cap-3', 'Notify Webhook', 'webhook'),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CapabilitiesListPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "Capabilities" heading', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue(MOCK_CAPABILITIES as any);
    vi.mocked(prisma.aiCapability.count).mockResolvedValue(3);

    const { default: CapabilitiesListPage } =
      await import('@/app/admin/orchestration/capabilities/page');

    render(await CapabilitiesListPage());

    expect(screen.getByRole('heading', { name: /^capabilities$/i })).toBeInTheDocument();
  });

  it('renders capability names from pre-fetched data', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue(MOCK_CAPABILITIES as any);
    vi.mocked(prisma.aiCapability.count).mockResolvedValue(3);

    const { default: CapabilitiesListPage } =
      await import('@/app/admin/orchestration/capabilities/page');

    render(await CapabilitiesListPage());

    await waitFor(() => {
      expect(screen.getByText('Search Knowledge')).toBeInTheDocument();
      expect(screen.getByText('Send Email')).toBeInTheDocument();
      expect(screen.getByText('Notify Webhook')).toBeInTheDocument();
    });
  });

  it('renders "+ New Capability" link', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue(MOCK_CAPABILITIES as any);
    vi.mocked(prisma.aiCapability.count).mockResolvedValue(3);

    const { default: CapabilitiesListPage } =
      await import('@/app/admin/orchestration/capabilities/page');

    render(await CapabilitiesListPage());

    await waitFor(() => {
      expect(screen.getByRole('link', { name: /new capability/i })).toBeInTheDocument();
    });
  });

  it('renders empty state when prisma returns empty array', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiCapability.count).mockResolvedValue(0);

    const { default: CapabilitiesListPage } =
      await import('@/app/admin/orchestration/capabilities/page');

    render(await CapabilitiesListPage());

    expect(screen.getByRole('heading', { name: /^capabilities$/i })).toBeInTheDocument();
    expect(screen.getByText(/no capabilities found/i)).toBeInTheDocument();
  });

  it('does not throw when prisma rejects', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiCapability.findMany).mockRejectedValue(new Error('Database error'));
    vi.mocked(prisma.aiCapability.count).mockRejectedValue(new Error('Database error'));

    const { default: CapabilitiesListPage } =
      await import('@/app/admin/orchestration/capabilities/page');

    let thrown = false;
    try {
      render(await CapabilitiesListPage());
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^capabilities$/i })).toBeInTheDocument();
  });
});
