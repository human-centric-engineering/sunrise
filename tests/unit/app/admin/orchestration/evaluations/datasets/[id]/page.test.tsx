// @vitest-environment happy-dom

/**
 * Unit Tests: DatasetDetailPage
 * (app/admin/orchestration/evaluations/datasets/[id]/page.tsx)
 *
 * - Happy path: dataset name, case count, cases handed to the table, agents
 *   handed to the synthesis button
 * - Dataset: a 404 is notFound(); any other failure throws ServerLoadError to
 *   the error boundary and never reads as a missing dataset (#518)
 * - Agents (secondary): a failure shows a notice in the synthesis button's
 *   place, not a button whose dialog says no agents exist
 *
 * @see app/admin/orchestration/evaluations/datasets/[id]/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const { mockNotFound } = vi.hoisted(() => ({
  mockNotFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: mockNotFound,
  useRouter: vi.fn(() => ({ refresh: vi.fn() })),
}));

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/evaluations-foundations/generate-cases-button', () => ({
  GenerateCasesButton: ({ agents }: { agents: unknown[] }) => (
    <div data-testid="generate-cases-button" data-agent-count={String(agents.length)} />
  ),
}));

vi.mock('@/components/admin/orchestration/evaluations-foundations/dataset-cases-table', () => ({
  DatasetCasesTable: ({ initialCases }: { initialCases: unknown[] }) => (
    <div data-testid="dataset-cases-table" data-case-count={String(initialCases.length)} />
  ),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import DatasetDetailPage from '@/app/admin/orchestration/evaluations/datasets/[id]/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { API } from '@/lib/api/endpoints';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DATASET_ID = 'ds-1';

const DETAIL = {
  dataset: {
    id: DATASET_ID,
    name: 'Refund questions',
    description: 'Customer refund edge cases',
    tags: ['refunds'],
    caseCount: 2,
    contentHash: 'abcdef0123456789abcdef',
    source: 'upload',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  cases: [
    { id: 'c1', position: 0, input: 'Can I get a refund?', expectedOutput: null, metadata: null },
    { id: 'c2', position: 1, input: 'Late refund?', expectedOutput: 'Yes', metadata: null },
  ],
};

const AGENTS = [{ id: 'a1', name: 'Support bot', slug: 'support-bot' }];

type Answer = () => Promise<Response>;

/** Route the dataset load and the agent list load to fresh `Response`s. */
function wireFetches({
  dataset = () => Promise.resolve(apiSuccess(DETAIL)),
  agents = () => Promise.resolve(apiSuccess(AGENTS)),
}: { dataset?: Answer; agents?: Answer } = {}): void {
  vi.mocked(serverFetch).mockImplementation((url: string) =>
    url.includes('/agents') ? agents() : dataset()
  );
}

const params = (): Promise<{ id: string }> => Promise.resolve({ id: DATASET_ID });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DatasetDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the dataset and hands its cases and the agents to the children', async () => {
    wireFetches();

    render(await DatasetDetailPage({ params: params() }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Refund questions');
    expect(screen.getByTestId('dataset-cases-table')).toHaveAttribute('data-case-count', '2');
    expect(screen.getByTestId('generate-cases-button')).toHaveAttribute('data-agent-count', '1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const urls = vi.mocked(serverFetch).mock.calls.map(([url]) => url);
    expect(urls).toContain(API.ADMIN.ORCHESTRATION.evalDatasetById(DATASET_ID));
  });

  describe('dataset load', () => {
    it('calls notFound() when the dataset does not exist', async () => {
      wireFetches({ dataset: () => Promise.resolve(apiFailure(404, 'NOT_FOUND')) });

      await expect(DatasetDetailPage({ params: params() })).rejects.toThrow('NEXT_NOT_FOUND');
      expect(mockNotFound).toHaveBeenCalledOnce();
    });

    it('throws to the error boundary, not notFound(), when the load fails', async () => {
      wireFetches({ dataset: () => Promise.resolve(apiFailure(500)) });

      await expect(DatasetDetailPage({ params: params() })).rejects.toBeInstanceOf(ServerLoadError);
      expect(mockNotFound).not.toHaveBeenCalled();
    });

    it('throws to the error boundary, not notFound(), when serverFetch rejects', async () => {
      wireFetches({ dataset: () => Promise.reject(new Error('Network down')) });

      await expect(DatasetDetailPage({ params: params() })).rejects.toBeInstanceOf(ServerLoadError);
      expect(mockNotFound).not.toHaveBeenCalled();
    });
  });

  describe('agent list load', () => {
    it('shows a notice in place of the synthesis button when the agents fail', async () => {
      wireFetches({ agents: () => Promise.resolve(apiFailure(500)) });

      render(await DatasetDetailPage({ params: params() }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load chat agents for case generation/i
      );
      expect(screen.queryByTestId('generate-cases-button')).not.toBeInTheDocument();
      // The dataset itself still renders.
      expect(screen.getByTestId('dataset-cases-table')).toBeInTheDocument();
    });

    it('shows the notice, not an error page, when the agents reply is not a list', async () => {
      wireFetches({ agents: () => Promise.resolve(apiSuccess({ agents: AGENTS })) });

      render(await DatasetDetailPage({ params: params() }));

      expect(screen.getByRole('alert')).toHaveTextContent(
        /couldn.t load chat agents for case generation/i
      );
      expect(screen.queryByTestId('generate-cases-button')).not.toBeInTheDocument();
      expect(screen.getByTestId('dataset-cases-table')).toBeInTheDocument();
    });

    it('still renders the synthesis button for a real empty agent list', async () => {
      wireFetches({ agents: () => Promise.resolve(apiSuccess([])) });

      render(await DatasetDetailPage({ params: params() }));

      expect(screen.getByTestId('generate-cases-button')).toHaveAttribute('data-agent-count', '0');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});
