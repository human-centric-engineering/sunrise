// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Agents List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid serverFetch response
 * - An empty list renders the table's empty state
 * - A failed load throws to the error boundary instead (#518)
 *
 * @see app/admin/orchestration/agents/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
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
  unstable_rethrow: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),

  useSearchParams: () => ({ get: () => null }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeAgent(id: string, name: string) {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    description: 'A test agent',
    systemInstructions: 'Be helpful',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
    temperature: 0.7,
    maxTokens: 4096,
    monthlyBudgetUsd: null,
    isActive: true,
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
    systemInstructionsHistory: [],
    metadata: {},
    deletedAt: null,
    _count: { capabilities: 0, conversations: 0 },
    _budget: null,
  };
}

const MOCK_AGENTS = [makeAgent('agent-1', 'Alpha Bot'), makeAgent('agent-2', 'Beta Bot')];

const MOCK_META = {
  page: 1,
  limit: 25,
  total: 2,
  totalPages: 1,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AgentsListPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders Agents heading and description', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_AGENTS, MOCK_META));

    // Import the page after mocks are set up
    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    // Act: render server component (async)
    render(await AgentsListPage());

    // Assert: headings present
    expect(screen.getByRole('heading', { name: /^agents$/i })).toBeInTheDocument();
    expect(
      screen.getByText(/create, edit, duplicate, import\/export, and test/i)
    ).toBeInTheDocument();
  });

  it('renders agent names from pre-fetched data', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_AGENTS, MOCK_META));

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    // Act
    render(await AgentsListPage());

    // Assert: agent names appear (via AgentsTable)
    await waitFor(() => {
      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
    });
  });

  it('renders the empty state when there are no agents', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { ...MOCK_META, total: 0 }));

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    render(await AgentsListPage());

    expect(screen.getByRole('heading', { name: /^agents$/i })).toBeInTheDocument();
    expect(screen.getByText(/no agents yet/i)).toBeInTheDocument();
  });

  it('throws instead of showing "no agents yet" when the load fails', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { logger } = await import('@/lib/logging');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    await expect(AgentsListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const { ServerLoadError } = await import('@/lib/api/server-load');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    await expect(AgentsListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });
});
