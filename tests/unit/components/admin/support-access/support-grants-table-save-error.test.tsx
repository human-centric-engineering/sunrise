// @vitest-environment happy-dom

/**
 * SupportGrantsTable — failed revoke (§124)
 *
 * A refused revoke keeps its dialog open with the refusal inside it, above
 * the dialog's buttons; it used to close the dialog and show it at the top.
 *
 * @see components/admin/support-access/support-grants-table.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  SupportGrantsTable,
  type SupportGrantRow,
} from '@/components/admin/support-access/support-grants-table';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

// The real APIClientError, so the table reads the failure as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

const grant: SupportGrantRow = {
  id: 'g-open',
  level: 'ADMIN',
  reason: 'Ticket 42',
  expiresAt: '2026-10-17T12:00:00.000Z',
  createdAt: '2026-10-16T12:00:00.000Z',
  revokedAt: null,
  grantedBy: { id: 'u-1', name: 'Olive Owner' },
  revokedBy: null,
  open: true,
};

describe('SupportGrantsTable — failed revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('keeps the revoke dialog open with the refusal above its buttons', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Support grant not found', 'NOT_FOUND', 404)
    );
    const user = userEvent.setup();
    render(<SupportGrantsTable orgId="org-1" grants={[grant]} />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Revoke' });
    await user.click(confirm);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Support grant not found');
    expect(alert.nextElementSibling).toContainElement(confirm);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(alert).toHaveFocus();
  });
});
