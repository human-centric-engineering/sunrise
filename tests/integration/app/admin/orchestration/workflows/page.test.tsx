// @vitest-environment happy-dom

/**
 * Integration Test: Admin Orchestration — Workflows List Page
 *
 * Tests the server-component page at
 * `app/admin/orchestration/workflows/page.tsx`.
 *
 * Test Coverage:
 * - Renders heading and description with valid serverFetch response
 * - With 3 workflows in the response, the table renders 3 rows
 * - A genuinely empty list → the "No workflows found" empty state, no banner
 * - A failed load (500 or no response) → the table's "Failed to load
 *   workflows" banner and a logged error, never a silent empty list (#518)
 *
 * @see app/admin/orchestration/workflows/page.tsx
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
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_WORKFLOWS, MOCK_META));

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(screen.getByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
  });

  it('renders 3 workflow names from the pre-fetched data', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(MOCK_WORKFLOWS, MOCK_META));

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    await waitFor(() => {
      expect(screen.getByText('Alpha Flow')).toBeInTheDocument();
      expect(screen.getByText('Beta Flow')).toBeInTheDocument();
      expect(screen.getByText('Gamma Flow')).toBeInTheDocument();
    });
  });

  it('renders the empty state, with no error banner, for a genuinely empty list', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { ...MOCK_META, total: 0 }));

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(screen.getByText(/no workflows found/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed to load workflows')).not.toBeInTheDocument();
  });

  it('shows the "Failed to load workflows" banner when the API answers 500', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(screen.getByRole('heading', { name: /^workflows$/i })).toBeInTheDocument();
    expect(screen.getByText('Failed to load workflows')).toBeInTheDocument();
  });

  it('logs and shows the banner, without throwing, when serverFetch rejects', async () => {
    const { serverFetch } = await import('@/lib/api/server-fetch');
    const fetchErr = new Error('Network error');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    const { logger } = await import('@/lib/logging');
    const { default: WorkflowsListPage } = await import('@/app/admin/orchestration/workflows/page');

    render(await WorkflowsListPage());

    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
    expect(screen.getByText('Failed to load workflows')).toBeInTheDocument();
  });
});
