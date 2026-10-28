// @vitest-environment happy-dom

/**
 * MemberInviteForm — failed save (§124)
 *
 * A failed send shows inside the form, under Send and above where "Send it
 * again" is offered; a field the server names gets its message and the focus.
 * Both sends share the one failure.
 *
 * @see components/admin/members/member-invite-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MemberInviteForm } from '@/components/admin/members/member-invite-form';

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
async function fillAndSend(user: ReturnType<typeof userEvent.setup>) {
  render(<MemberInviteForm orgId="org-1" />);
  await user.type(screen.getByLabelText('Name'), 'New Person');
  await user.type(screen.getByLabelText(/^Email/, { selector: 'input' }), 'new@example.com');
  const send = screen.getByRole('button', { name: /send invitation/i });
  await user.click(send);
  return send;
}

describe('MemberInviteForm — failed save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows the failure beside Send, and focuses it', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Only an owner may invite an owner', 'FORBIDDEN', 403)
    );

    const send = await fillAndSend(userEvent.setup());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Only an owner may invite an owner');
    expect(alert.parentElement).toContainElement(send);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('shows a failed "Send it again" by Send too', async () => {
    const { apiClient, APIClientError } = await import('@/lib/api/client');
    vi.mocked(apiClient.post)
      .mockResolvedValueOnce({
        message: 'Already invited',
        invitation: { email: 'new@example.com', name: 'New Person' },
        emailStatus: 'pending',
      })
      .mockRejectedValueOnce(new APIClientError('The invitation has expired', 'GONE', 410));
    const user = userEvent.setup();

    const send = await fillAndSend(user);
    await user.click(await screen.findByRole('button', { name: 'Send it again' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The invitation has expired');
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

    await fillAndSend(userEvent.setup());

    await waitFor(() => expect(document.querySelector('[name="email"]')).toHaveFocus());
    expect(screen.getByText('That domain does not accept mail')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('1 field needs fixing.');
  });
});
