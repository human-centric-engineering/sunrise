// @vitest-environment happy-dom

/**
 * Unit Tests: ApprovalQueuePage (app/admin/orchestration/approvals/page.tsx)
 *
 * - a failed load (5xx, success:false, no response) throws to the error
 *   boundary instead of rendering an empty queue, which would read as
 *   "nothing to approve" (#518)
 * - happy path → approvals + meta forwarded to ApprovalsTabs, read with the
 *   paused_for_approval filter
 * - a genuinely empty queue is rendered as an empty queue
 *
 * @see app/admin/orchestration/approvals/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/components/admin/orchestration/approvals-tabs', () => ({
  ApprovalsTabs: (props: { initialApprovals: unknown[]; initialMeta: { total: number } }) => (
    <div
      data-testid="approvals-tabs"
      data-count={String(props.initialApprovals.length)}
      data-total={String(props.initialMeta.total)}
    />
  ),
}));

vi.mock('@/components/ui/field-help', () => ({
  FieldHelp: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import ApprovalQueuePage from '@/app/admin/orchestration/approvals/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

describe('ApprovalQueuePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws to the error boundary when the executions API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(ApprovalQueuePage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when the executions API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(ApprovalQueuePage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws and logs when serverFetch rejects', async () => {
    const err = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(err);

    await expect(ApprovalQueuePage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), err, expect.any(Object));
  });

  it('reads paused executions and forwards them to ApprovalsTabs', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess([{ id: 'ex-1' }, { id: 'ex-2' }], { page: 1, limit: 25, total: 2, totalPages: 1 })
    );

    render(await ApprovalQueuePage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.EXECUTIONS}?page=1&limit=25&status=paused_for_approval`
    );
    const tabs = screen.getByTestId('approvals-tabs');
    expect(tabs).toHaveAttribute('data-count', '2');
    expect(tabs).toHaveAttribute('data-total', '2');
  });

  it('renders an empty queue as an empty queue', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await ApprovalQueuePage());

    const tabs = screen.getByTestId('approvals-tabs');
    expect(tabs).toHaveAttribute('data-count', '0');
    expect(tabs).toHaveAttribute('data-total', '0');
  });
});
