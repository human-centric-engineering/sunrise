// @vitest-environment happy-dom

/**
 * Admin — Organisations list page (§120 t-745).
 *
 * @see app/admin/orgs/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/lib/api/server-fetch', () => ({
  serverFetch: vi.fn(),
  parseApiResponse: vi.fn(),
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
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';

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
    vi.mocked(serverFetch).mockResolvedValue({ ok: true } as Response);
    vi.mocked(parseApiResponse).mockResolvedValue({
      success: true,
      data: { orgs: [ACME] },
    } as never);

    render(await OrgsPage());

    expect(serverFetch).toHaveBeenCalledWith('/api/v1/admin/orgs');
    expect(screen.getByRole('heading', { name: /Organisations/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme' })).toHaveAttribute(
      'href',
      `/admin/orgs/${ACME.id}`
    );
  });

  it('renders the empty state when the fetch is refused', async () => {
    vi.mocked(serverFetch).mockResolvedValue({ ok: false } as Response);

    render(await OrgsPage());

    expect(screen.getByText('No organisations could be loaded.')).toBeInTheDocument();
  });

  it('renders the empty state, and logs, when the fetch throws', async () => {
    vi.mocked(serverFetch).mockRejectedValue(new Error('network'));

    render(await OrgsPage());

    expect(screen.getByText('No organisations could be loaded.')).toBeInTheDocument();
    expect(logger.error).toHaveBeenCalledWith('orgs list page: fetch failed', expect.any(Error));
  });
});
