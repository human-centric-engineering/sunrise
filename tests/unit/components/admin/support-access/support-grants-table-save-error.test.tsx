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
import { act, render, screen, within } from '@testing-library/react';
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

  it('is committed to a revoke in flight: no second request, no Cancel, no Escape', async () => {
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.delete).mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    render(<SupportGrantsTable orgId="org-1" grants={[grant]} />);

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Revoke' });
    await user.click(confirm);

    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(confirm);
    await user.keyboard('{Escape}');

    expect(apiClient.delete).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it("never shows one grant's failed revoke in the next grant's dialog", async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    let reject: (err: unknown) => void = () => {};
    vi.mocked(apiClient.delete).mockReturnValue(
      new Promise((_, rej) => {
        reject = rej;
      })
    );
    const user = userEvent.setup();
    render(<SupportGrantsTable orgId="org-1" grants={[grant, { ...grant, id: 'g-other' }]} />);

    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[0]);
    const first = await screen.findByRole('alertdialog');
    await user.click(within(first).getByRole('button', { name: 'Revoke' }));
    // An attempt to leave while the request is in flight, then it fails.
    await user.keyboard('{Escape}');
    await act(async () => reject(new APIClientError('Support grant not found', 'NOT_FOUND', 404)));
    // Leave the dialog if it is still open (it should be: it ignored the Escape).
    const open = screen.queryByRole('alertdialog');
    if (open) await user.click(within(open).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getAllByRole('button', { name: 'Revoke' })[1]);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
    expect(apiClient.delete).toHaveBeenCalledWith(expect.stringContaining('g-open'));
  });
});
