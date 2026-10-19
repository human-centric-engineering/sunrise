// @vitest-environment happy-dom

/**
 * Admin — Organisations list page (§120 t-745).
 *
 * The org list is what the page exists to show, so a failed load throws to
 * the admin error boundary instead of rendering the table's empty state
 * (#518). Only `serverFetch` is faked: the real parser and
 * `requireServerData` run.
 *
 * @see app/admin/orgs/page.tsx
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

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import OrgsPage from '@/app/admin/orgs/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

const ACME = {
  id: 'cmorg00000000000000grant',
  slug: 'acme',
  name: 'Acme',
  status: 'ACTIVE',
  createdAt: '2026-09-01T00:00:00.000Z',
  memberCount: 3,
  ownerCount: 1,
};

describe('OrgsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every org from the admin orgs endpoint', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ orgs: [ACME] }));

    render(await OrgsPage());

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe('/api/v1/admin/orgs');
    expect(screen.getByRole('heading', { name: /Organisations/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute(
      'href',
      `/admin/orgs/${ACME.id}`
    );
  });

  it('renders a genuinely empty list as the empty state', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess({ orgs: [] }));

    render(await OrgsPage());

    expect(screen.getByText('No organisations could be loaded.')).toBeInTheDocument();
  });

  // ── A failed load is a failure, not an empty table (#518) ───────────────

  it('throws to the error boundary when the orgs API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(OrgsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws when the orgs API refuses the caller', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(403, 'FORBIDDEN'));

    await expect(OrgsPage()).rejects.toBeInstanceOf(ServerLoadError);
  });

  it('throws, and logs, when the fetch rejects', async () => {
    const failure = new Error('network');
    vi.mocked(serverFetch).mockRejectedValue(failure);

    await expect(OrgsPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure, expect.any(Object));
  });
});
