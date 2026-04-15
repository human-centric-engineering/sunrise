/**
 * Integration Test: Admin Orchestration — Workflows List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/workflows/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid prisma response
 * - With 3 workflows in the response, the table renders 3 rows
 * - Rejecting prisma → table renders empty state, logger.error called
 *
 * @see app/admin/orchestration/workflows/page.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
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

function makeWorkflow(id: string, name: string) {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    description: 'A test workflow',
    workflowDefinition: { steps: [], entryStepId: '', errorStrategy: 'fail' },
    patternsUsed: [1],
    isActive: true,
    isTemplate: false,
    metadata: null,
    createdBy: 'user-1',
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };
}

const MOCK_WORKFLOWS = [
  makeWorkflow('wf-1', 'Alpha Flow'),
  makeWorkflow('wf-2', 'Beta Flow'),
  makeWorkflow('wf-3', 'Gamma Flow'),
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowsListPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Workflows heading', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue(MOCK_WORKFLOWS as any);
    vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(3);

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(screen.getByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
  });

  it('renders 3 workflow names from the pre-fetched data', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue(MOCK_WORKFLOWS as any);
    vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(3);

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    await waitFor(() => {
      expect(screen.getByText('Alpha Flow')).toBeInTheDocument();
      expect(screen.getByText('Beta Flow')).toBeInTheDocument();
      expect(screen.getByText('Gamma Flow')).toBeInTheDocument();
    });
  });

  it('renders empty state gracefully when prisma returns empty array', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);
    vi.mocked(prisma.aiWorkflow.count).mockResolvedValue(0);

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(screen.getByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
    expect(screen.getByText(/no workflows found/i)).toBeInTheDocument();
  });

  it('does not throw and calls logger.error when prisma rejects', async () => {
    const { prisma } = await import('@/lib/db/client');
    vi.mocked(prisma.aiWorkflow.findMany).mockRejectedValue(new Error('Database error'));
    vi.mocked(prisma.aiWorkflow.count).mockRejectedValue(new Error('Database error'));

    const { logger } = await import('@/lib/logging');
    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    let thrown = false;
    try {
      render(await WorkflowsListPage());
    } catch {
      thrown = true;
    }

    expect(thrown).toBe(false);
    expect(logger.error).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
  });
});
