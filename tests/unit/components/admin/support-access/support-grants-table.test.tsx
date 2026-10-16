// @vitest-environment happy-dom

/**
 * SupportGrantsTable (§121 t-823): each grant's status, revoke on the open one
 * only, and the API's answer shown as given.
 *
 * @see components/admin/support-access/support-grants-table.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  SupportGrantsTable,
  type SupportGrantRow,
} from '@/components/admin/support-access/support-grants-table';
import { apiClient, APIClientError } from '@/lib/api/client';

const mockRefresh = vi.fn();

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter({ refresh: mockRefresh }) };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { delete: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

const grant = (over: Partial<SupportGrantRow>): SupportGrantRow => ({
  id: 'g-open',
  level: 'ADMIN',
  reason: 'Ticket 42',
  expiresAt: '2026-10-17T12:00:00.000Z',
  createdAt: '2026-10-16T12:00:00.000Z',
  revokedAt: null,
  grantedBy: { id: 'u-1', name: 'Olive Owner' },
  revokedBy: null,
  open: true,
  ...over,
});

const GRANTS = [
  grant({}),
  grant({
    id: 'g-revoked',
    level: 'READ_ONLY',
    open: false,
    revokedAt: '2026-10-15T12:00:00.000Z',
    revokedBy: { id: 'u-2', name: 'Ada Admin' },
  }),
  grant({ id: 'g-expired', open: false, grantedBy: null }),
];

describe('SupportGrantsTable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks each grant open, revoked or expired, and offers revoke on the open one only', () => {
    render(<SupportGrantsTable orgId="org-1" grants={GRANTS} />);

    const [, openRow, revokedRow, expiredRow] = screen.getAllByRole('row');
    expect(openRow).toHaveTextContent('Open');
    expect(openRow).toHaveTextContent('Admin');
    expect(within(openRow).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    expect(revokedRow).toHaveTextContent('Revoked');
    expect(revokedRow).toHaveTextContent('Read-only');
    expect(revokedRow).toHaveTextContent('by Ada Admin');
    expect(within(revokedRow).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();

    expect(expiredRow).toHaveTextContent('Expired');
    expect(expiredRow).toHaveTextContent('Deleted account');
    expect(within(expiredRow).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('says when support has never had access', () => {
    render(<SupportGrantsTable orgId="org-1" grants={[]} />);
    expect(screen.getByText(/never been given access/)).toBeInTheDocument();
  });

  it('revokes after confirming, then refreshes', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockResolvedValue({});
    render(<SupportGrantsTable orgId="org-1" grants={GRANTS} />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(apiClient.delete).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' })
    );

    await waitFor(() =>
      expect(apiClient.delete).toHaveBeenCalledWith('/api/v1/orgs/org-1/support-grants/g-open')
    );
    expect(mockRefresh).toHaveBeenCalled();
  });

  it('shows the API’s refusal as worded', async () => {
    const user = userEvent.setup();
    vi.mocked(apiClient.delete).mockRejectedValue(new APIClientError('Support grant not found'));
    render(<SupportGrantsTable orgId="org-1" grants={GRANTS} />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Revoke' })
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Support grant not found');
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
