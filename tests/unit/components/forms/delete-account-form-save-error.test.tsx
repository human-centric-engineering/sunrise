// @vitest-environment happy-dom

/**
 * DeleteAccountForm save-error behaviour (t-950)
 *
 * A refused delete keeps the confirm dialog open and shows its failure inside
 * it, above the buttons. While the request is in flight the dialog is
 * committed (Cancel and the action disabled, Escape ignored); once it has
 * failed, Escape closes it and a reopened dialog starts clean. A 409 is the
 * pending-deletion answer, not an error.
 *
 * @see components/forms/delete-account-form.tsx
 * @see lib/hooks/use-committed-dialog.ts
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DeleteAccountForm } from '@/components/forms/delete-account-form';
import { apiClient, APIClientError } from '@/lib/api/client';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { delete: vi.fn() },
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({ reset: vi.fn().mockResolvedValue(undefined) })),
}));

type User = ReturnType<typeof userEvent.setup>;

async function openDialog(user: User) {
  await user.click(screen.getByRole('button', { name: 'Delete Account' }));
  return screen.findByRole('alertdialog');
}

async function confirmDelete(user: User, dialog: HTMLElement) {
  await user.type(within(dialog).getByPlaceholderText('DELETE'), 'DELETE');
  await user.click(within(dialog).getByRole('button', { name: 'Delete Account' }));
}

describe('components/forms/delete-account-form save errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should keep the dialog open and show the refusal inside it, above the buttons, focused', async () => {
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('You still own an organisation', 'CONFLICT', 400)
    );
    const user = userEvent.setup();
    render(<DeleteAccountForm />);
    const dialog = await openDialog(user);

    await confirmDelete(user, dialog);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('You still own an organisation');
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const action = within(dialog).getByRole('button', { name: 'Delete Account' });
    expect(alert.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(alert.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should disable Cancel and the action and ignore Escape while the request is in flight', async () => {
    let reject: (err: unknown) => void = () => {};
    vi.mocked(apiClient.delete).mockImplementation(
      () => new Promise((_resolve, rej) => (reject = rej))
    );
    const user = userEvent.setup();
    render(<DeleteAccountForm />);
    const dialog = await openDialog(user);

    await confirmDelete(user, dialog);

    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    );
    expect(within(dialog).getByRole('button', { name: /Deleting/ })).toBeDisabled();

    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(apiClient.delete).toHaveBeenCalledTimes(1);

    reject(new APIClientError('Refused late', 'CONFLICT', 400));
    // The late refusal is still readable because the dialog stayed open.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Refused late');
  });

  it('should close on Escape after a failure, and show no stale alert or confirmation on reopening', async () => {
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('You still own an organisation', 'CONFLICT', 400)
    );
    const user = userEvent.setup();
    render(<DeleteAccountForm />);
    const dialog = await openDialog(user);
    await confirmDelete(user, dialog);
    await within(dialog).findByRole('alert');
    // Settled: the request is no longer in flight.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeEnabled()
    );

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    const reopened = await openDialog(user);
    expect(within(reopened).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('You still own an organisation')).not.toBeInTheDocument();
    expect(within(reopened).getByPlaceholderText('DELETE')).toHaveValue('');
  });

  it('should close on Cancel after a failure', async () => {
    vi.mocked(apiClient.delete).mockRejectedValue(new APIClientError('Nope', 'CONFLICT', 400));
    const user = userEvent.setup();
    render(<DeleteAccountForm />);
    const dialog = await openDialog(user);
    await confirmDelete(user, dialog);
    await within(dialog).findByRole('alert');

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('should show Deletion in progress, not an error, for a 409', async () => {
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Another request holds the deletion', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<DeleteAccountForm />);
    const dialog = await openDialog(user);

    await confirmDelete(user, dialog);

    expect(await within(dialog).findByText('Deletion in progress')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Another request holds the deletion')).not.toBeInTheDocument();
  });

  it('should show the fallback, not the browser text, for a network failure', async () => {
    vi.mocked(apiClient.delete).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR')
    );
    const user = userEvent.setup();
    render(<DeleteAccountForm />);
    const dialog = await openDialog(user);

    await confirmDelete(user, dialog);

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Could not delete your account. Try again in a moment.');
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });
});
