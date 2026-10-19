// @vitest-environment happy-dom

/**
 * Unit Tests: NewDatasetPage
 * (app/admin/orchestration/evaluations/datasets/new/page.tsx)
 *
 * The chat-agent list feeds the "generate from description" tab, which reads
 * an empty list as "no chat agents exist — create one". So a failed load is
 * handed to the tabs as `null` (the generate tab shows a notice), never as
 * `[]`, and the rest of the page still renders (#518); a real empty list
 * still reaches the form.
 *
 * @see app/admin/orchestration/evaluations/datasets/new/page.tsx
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

vi.mock('@/components/admin/orchestration/evaluations-foundations/dataset-new-tabs', () => ({
  DatasetNewTabs: ({ agents }: { agents: unknown[] | null }) => (
    <div
      data-testid="dataset-new-tabs"
      data-agent-count={agents === null ? 'failed' : String(agents.length)}
    />
  ),
}));

vi.mock('@/components/admin/orchestration/evaluations-foundations/dataset-anatomy-card', () => ({
  DatasetAnatomyCard: () => <div data-testid="dataset-anatomy-card" />,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// ─── Imports (after mocks) ─────────────────────────────────────────────────

import NewDatasetPage from '@/app/admin/orchestration/evaluations/datasets/new/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('NewDatasetPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands the chat agents to the tabs', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess([{ id: 'a1', name: 'Support bot', slug: 'support-bot' }])
    );

    render(await NewDatasetPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New dataset');
    expect(screen.getByTestId('dataset-new-tabs')).toHaveAttribute('data-agent-count', '1');
    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.AGENTS}?limit=100&kind=chat`
    );
  });

  it('hands a real empty agent list to the tabs', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await NewDatasetPage());

    expect(screen.getByTestId('dataset-new-tabs')).toHaveAttribute('data-agent-count', '0');
  });

  it('renders the page and hands the tabs null when the agent load fails', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    render(await NewDatasetPage());

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('New dataset');
    expect(screen.getByTestId('dataset-anatomy-card')).toBeInTheDocument();
    expect(screen.getByTestId('dataset-new-tabs')).toHaveAttribute('data-agent-count', 'failed');
    expect(logger.error).toHaveBeenCalledWith(
      'Server data load failed',
      undefined,
      expect.objectContaining({ status: 500 })
    );
  });

  it('hands the tabs null, not an empty list, when serverFetch rejects', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('Network down'));

    render(await NewDatasetPage());

    expect(screen.getByTestId('dataset-new-tabs')).toHaveAttribute('data-agent-count', 'failed');
  });
});
