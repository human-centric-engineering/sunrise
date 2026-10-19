// @vitest-environment happy-dom

/**
 * Unit Tests: DatasetsListPage
 * (app/admin/orchestration/evaluations/datasets/page.tsx)
 *
 * - Datasets render in the table
 * - A real empty list renders "No datasets yet" + the Evaluation 101 card
 * - A failed load throws ServerLoadError to the error boundary rather than
 *   reading as "No datasets yet" (#518)
 *
 * @see app/admin/orchestration/evaluations/datasets/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/evaluations-foundations/datasets-table', () => ({
  DatasetsTable: ({ datasets }: { datasets: unknown[] }) => (
    <div data-testid="datasets-table" data-count={String(datasets.length)} />
  ),
}));

vi.mock('@/components/admin/orchestration/evaluations-foundations/evaluation-101-card', () => ({
  Evaluation101Card: () => <div data-testid="evaluation-101-card" />,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import DatasetsListPage from '@/app/admin/orchestration/evaluations/datasets/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { API } from '@/lib/api/endpoints';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DatasetsListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the datasets in the table', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess([
        { id: 'd1', name: 'One' },
        { id: 'd2', name: 'Two' },
      ])
    );

    render(await DatasetsListPage());

    expect(screen.getByTestId('datasets-table')).toHaveAttribute('data-count', '2');
    expect(screen.queryByText('No datasets yet.')).not.toBeInTheDocument();
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.EVAL_DATASETS}?limit=50`
    );
  });

  it('renders the empty state for a real empty list', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await DatasetsListPage());

    expect(screen.getByText('No datasets yet.')).toBeInTheDocument();
    expect(screen.getByTestId('evaluation-101-card')).toBeInTheDocument();
    expect(screen.queryByTestId('datasets-table')).not.toBeInTheDocument();
  });

  it('throws to the error boundary, not "No datasets yet", when the load fails', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(DatasetsListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws to the error boundary when serverFetch rejects', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network down'));

    await expect(DatasetsListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });
});
