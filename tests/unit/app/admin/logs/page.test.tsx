// @vitest-environment happy-dom

/**
 * Unit Tests: AdminLogsPage (app/admin/logs/page.tsx)
 *
 * The log list is what the page exists to show, so a failed load (5xx,
 * success:false, no response) throws to the admin error boundary instead of
 * rendering "No logs found" (#518). A real empty buffer still renders as an
 * empty list.
 *
 * Only `serverFetch` is faked: the real parser and `requireServerData` run.
 * No auth-redirect test: the admin guard lives in `app/admin/layout.tsx`.
 *
 * @see app/admin/logs/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// Stub the viewer and record what it was handed.
vi.mock('@/components/admin/logs-viewer', () => ({
  LogsViewer: (props: { initialLogs: unknown[]; initialMeta: unknown }) => (
    <div
      data-testid="logs-viewer"
      data-count={String(props.initialLogs.length)}
      data-meta={JSON.stringify(props.initialMeta)}
    />
  ),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import AdminLogsPage from '@/app/admin/logs/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const LOGS = [
  { id: 'log-1', timestamp: '2026-10-19T10:00:00.000Z', level: 'info', message: 'one' },
  { id: 'log-2', timestamp: '2026-10-19T10:01:00.000Z', level: 'error', message: 'two' },
];

function metaPassed(): unknown {
  return JSON.parse(screen.getByTestId('logs-viewer').getAttribute('data-meta') ?? 'null');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminLogsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── A failed load is a failure, not an empty log (#518) ─────────────────

  it('throws to the error boundary when the logs API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(AdminLogsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when the logs API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(AdminLogsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws and logs when serverFetch rejects', async () => {
    const fetchErr = new Error('ECONNREFUSED');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    await expect(AdminLogsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
  });

  // ── Happy path ───────────────────────────────────────────────────────────

  it('hands the logs and their pagination meta to the viewer', async () => {
    const meta = { page: 1, limit: 50, total: 120, totalPages: 3 };
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(LOGS, meta));

    render(await AdminLogsPage());

    expect(screen.getByTestId('logs-viewer')).toHaveAttribute('data-count', '2');
    expect(metaPassed()).toEqual(meta);
  });

  it('renders an empty log as an empty log, with fallback meta when none is sent', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    render(await AdminLogsPage());

    expect(screen.getByTestId('logs-viewer')).toHaveAttribute('data-count', '0');
    expect(metaPassed()).toEqual({ page: 1, limit: 50, total: 0, totalPages: 1 });
  });

  it('reads the admin logs endpoint with the page limit', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([]));

    await AdminLogsPage();

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(`${API.ADMIN.LOGS}?limit=50`);
  });
});
