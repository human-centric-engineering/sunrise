// @vitest-environment happy-dom

/**
 * UserInviteForm — failed save (§124)
 *
 * Send is in the card footer, below the fields. A failed send must show
 * beside it, not at the top of the card, and a field the server names gets
 * its message and the focus.
 *
 * @see components/admin/user-invite-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { UserInviteForm } from '@/components/admin/user-invite-form';

vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return { useRouter: () => createMockRouter() };
});

// The real APIClientError, so the form reads `details` as it would in the app.
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

/** Fills the form validly and presses Send. */
async function fillAndSend() {
  const user = userEvent.setup();
  render(<UserInviteForm />);
  await user.type(screen.getByLabelText('Name'), 'New Person');
  await user.type(screen.getByLabelText('Email'), 'new@example.com');
  const send = screen.getByRole('button', { name: /send invitation/i });
  await user.click(send);
  return send;
}

describe('UserInviteForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Send, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Email already has a pending invitation', 'CONFLICT', 409)
    );

    const send = await fillAndSend();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email already has a pending invitation');
    expect(alert.parentElement).toContainElement(send);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('puts a rejected field’s message under it and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'email', message: 'That domain does not accept mail' }],
      })
    );

    await fillAndSend();

    await waitFor(() => expect(document.querySelector('[name="email"]')).toHaveFocus());
    expect(screen.getByText('That domain does not accept mail')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });

  it('sends the role picked and focuses the role select when the server rejects it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invalid request body', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'role', message: 'You cannot invite an admin' }],
      })
    );
    const user = userEvent.setup();
    render(<UserInviteForm />);
    await user.type(screen.getByLabelText('Name'), 'New Person');
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    const role = screen.getByRole('combobox', { name: 'Role' });
    role.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Admin' }));

    await user.click(screen.getByRole('button', { name: /send invitation/i }));

    expect(apiClient.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.objectContaining({ role: 'ADMIN' }) })
    );
    // The trigger carries the field name as its id, so focus can reach it.
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Role' })).toHaveFocus());
    expect(screen.getByText('You cannot invite an admin')).toBeInTheDocument();
  });
});
