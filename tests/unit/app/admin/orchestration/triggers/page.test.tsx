// @vitest-environment happy-dom

/**
 * Unit Tests: TriggersListPage (app/admin/orchestration/triggers/page.tsx)
 *
 * - a failed load (5xx, success:false, no response) throws to the error
 *   boundary instead of rendering an empty table (#518)
 * - happy path → triggers and the registered channels from `meta` reach the
 *   table and the adapters strip
 * - a genuinely empty list is rendered as an empty list
 *
 * @see app/admin/orchestration/triggers/page.tsx
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

vi.mock('@/components/admin/orchestration/triggers-table', () => ({
  TriggersTable: (props: { triggers: unknown[]; enabledChannels: string[] }) => (
    <div
      data-testid="triggers-table"
      data-count={String(props.triggers.length)}
      data-channels={props.enabledChannels.join(',')}
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

// ─── Imports (after mocks) ─────────────────────────────────────────────────────

import TriggersListPage from '@/app/admin/orchestration/triggers/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { API } from '@/lib/api/endpoints';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRIGGERS = [
  { id: 'tr-1', channel: 'slack', name: 'Slack intake' },
  { id: 'tr-2', channel: 'postmark', name: 'Email intake' },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TriggersListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards triggers and registered channels from the list response', async () => {
    vi.mocked(serverFetch).mockResolvedValue(
      apiSuccess(TRIGGERS, { enabledChannels: ['slack', 'postmark'] })
    );

    render(await TriggersListPage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe(
      `${API.ADMIN.ORCHESTRATION.TRIGGERS}?page=1&limit=100`
    );
    const table = screen.getByTestId('triggers-table');
    expect(table).toHaveAttribute('data-count', '2');
    expect(table).toHaveAttribute('data-channels', 'slack,postmark');
    expect(screen.getByText(/Registered adapters in this deployment/)).toBeInTheDocument();
  });

  it('renders a genuinely empty list as an empty list', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess([], { enabledChannels: [] }));

    render(await TriggersListPage());

    expect(screen.getByTestId('triggers-table')).toHaveAttribute('data-count', '0');
  });

  // ── A failed load is a failure, not an empty table (#518) ────────────────

  it('throws to the error boundary when the triggers API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(TriggersListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws when the triggers API answers success:false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(TriggersListPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('logs and throws when serverFetch rejects', async () => {
    const fetchErr = new Error('Network failure');
    vi.mocked(serverFetch).mockRejectedValue(fetchErr);

    await expect(TriggersListPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), fetchErr, expect.any(Object));
  });
});
