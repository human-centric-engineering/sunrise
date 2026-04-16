/**
 * Integration Test: Admin Orchestration — Workflows List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/workflows/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid serverFetch response
 * - With 3 workflows in the response, the table renders 3 rows
 * - Rejecting fetch → table renders empty state, logger.error called
 *
 * @see app/admin/orchestration/workflows/page.tsx
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
    createdAt: new Date('2025-01-01').toISOString(),
    updatedAt: new Date('2025-01-01').toISOString(),
    _count: { executions: 0 },
  };
}

const MOCK_WORKFLOWS = [
  makeWorkflow('wf-1', 'Alpha Flow'),
  makeWorkflow('wf-2', 'Beta Flow'),
  makeWorkflow('wf-3', 'Gamma Flow'),
];

const MOCK_META = {
  page: 1,
  limit: 25,
  total: 3,
  totalPages: 1,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('WorkflowsListPage (server component)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Workflows heading', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_WORKFLOWS,
      meta: MOCK_META,
    });

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(screen.getByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
  });

  it('renders 3 workflow names from the pre-fetched data', async () => {
    const { serverFetch, parseApiResponse } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: MOCK_WORKFLOWS,
      meta: MOCK_META,
    });

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    await waitFor(() => {
      expect(screen.getByText('Alpha Flow')).toBeInTheDocument();
      expect(screen.getByText('Beta Flow')).toBeInTheDocument();
      expect(screen.getByText('Gamma Flow')).toBeInTheDocument();
    });
  });

  it('renders empty state gracefully when serverFetch returns not ok', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(screen.getByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
    expect(screen.getByText(/no workflows found/i)).toBeInTheDocument();
  });

  it('does not throw and calls logger.error when serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network error'));

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
