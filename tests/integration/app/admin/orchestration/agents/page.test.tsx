/**
 * Integration Test: Admin Orchestration — Agents List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid serverFetch response
 * - Graceful empty state when serverFetch returns null data
 * - No throw when serverFetch rejects
 *
 * @see app/admin/orchestration/agents/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

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

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_AGENTS,
      meta: MOCK_META,
    });

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
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_AGENTS,
      meta: MOCK_META,
    });

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    // Act
    render(await AgentsListPage());

    // Assert: agent names appear (via AgentsTable)
    await waitFor(() => {
      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
    });
  });

  it('renders empty state gracefully when serverFetch returns not ok', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    // Act: should not throw
    render(await AgentsListPage());

    // Assert: page renders (empty state in table)
    expect(screen.getByRole('heading', { name: /^agents$/i })).toBeInTheDocument();
    expect(screen.getByText(/no agents yet/i)).toBeInTheDocument();
  });

  it('does not throw when serverFetch rejects', async () => {
    // Arrange
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    // Act: should not throw
    let thrown = false;
    try {
      render(await AgentsListPage());
    } catch {
      thrown = true;
    }

    // Assert
    expect(thrown).toBe(false);
    expect(screen.getByRole('heading', { name: /^agents$/i })).toBeInTheDocument();
  });
});
