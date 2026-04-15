/**
 * Integration Test: Admin Orchestration — Agents List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/agents/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid prisma response
 * - Graceful empty state when prisma returns empty array
 * - No throw when prisma rejects
 *
 * @see app/admin/orchestration/agents/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
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
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    systemInstructionsHistory: [],
    metadata: {},
    deletedAt: null,
  };
}

const MOCK_AGENTS = [makeAgent('agent-1', 'Alpha Bot'), makeAgent('agent-2', 'Beta Bot')];

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
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(MOCK_AGENTS as any);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(2);

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
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue(MOCK_AGENTS as any);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(2);

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    // Act
    render(await AgentsListPage());

    // Assert: agent names appear (via AgentsTable)
    await waitFor(() => {
      expect(screen.getByText('Alpha Bot')).toBeInTheDocument();
      expect(screen.getByText('Beta Bot')).toBeInTheDocument();
    });
  });

  it('renders empty state gracefully when prisma returns empty array', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);

    const { default: AgentsListPage } = await import('@/app/admin/orchestration/agents/page');

    // Act: should not throw
    render(await AgentsListPage());

    // Assert: page renders (empty state in table)
    expect(screen.getByRole('heading', { name: /^agents$/i })).toBeInTheDocument();
    expect(screen.getByText(/no agents found/i)).toBeInTheDocument();
  });

  it('does not throw when prisma rejects', async () => {
    // Arrange
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiAgent.findMany).mockRejectedValue(new Error('Database error'));
    vi.mocked(prisma.aiAgent.count).mockRejectedValue(new Error('Database error'));

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
