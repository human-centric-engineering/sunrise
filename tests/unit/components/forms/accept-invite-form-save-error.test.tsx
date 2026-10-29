// @vitest-environment happy-dom

/**
 * AcceptInviteForm save-error behaviour (t-950)
 *
 * A refused activation goes through the shared `<SaveError>` by Activate
 * Account; fields the server names get their message and the focus. Load
 * failures and the OAuth `?error=` notice are not save errors and keep
 * FormError / their own panel.
 *
 * @see components/forms/accept-invite-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AcceptInviteForm } from '@/components/forms/accept-invite-form';
import { apiClient, APIClientError } from '@/lib/api/client';
import { createMockRouter } from '@/tests/types/mocks';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: vi.fn(), post: vi.fn() },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => nav.params),
}));

vi.mock('@/components/forms/oauth-buttons', () => ({ OAuthButtons: () => null }));

vi.mock('@/lib/auth/client', () => ({
  authClient: { signIn: { email: vi.fn().mockResolvedValue({ data: null }) } },
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({ identify: vi.fn() })),
}));

vi.mock('@/lib/analytics/events', () => ({
  useFormAnalytics: vi.fn(() => ({ trackFormSubmitted: vi.fn() })),
}));

async function activate(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Password'), 'Password123!');
  await user.type(screen.getByLabelText('Confirm Password'), 'Password123!');
  await user.click(screen.getByRole('button', { name: 'Activate Account' }));
}

describe('components/forms/accept-invite-form save errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams({ token: 'tok-1', email: 'invitee@example.com' });
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue(createMockRouter());
    vi.mocked(apiClient.get).mockResolvedValue({ name: 'Invitee', role: 'member' });
  });

  it('should put a named-field message under Password, focus that field, and summarise by Activate Account', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'password', message: 'Password is too weak' }],
      })
    );
    const user = userEvent.setup();
    render(<AcceptInviteForm />);

    await activate(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 field needs fixing.');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Activate Account' }));

    const password = screen.getByLabelText('Password');
    const fieldMessage = screen.getByText('Password is too weak');
    expect(fieldMessage).not.toBe(alert);
    // The message sits in the Password field's own group, not the confirm field's.
    expect(password.closest('.space-y-2')).toContainElement(fieldMessage);
    await waitFor(() => expect(password).toHaveFocus());
    expect(alert).not.toHaveFocus();
  });

  it('should show a message about the read-only email by Activate Account, where it can be read', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, {
        errors: [{ path: 'email', message: 'Email does not match the invitation' }],
      })
    );
    const user = userEvent.setup();
    render(<AcceptInviteForm />);

    await activate(user);

    // Not "1 field needs fixing." pointing at a field no one can edit.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email does not match the invitation');
    expect(alert).not.toHaveTextContent('needs fixing');
    expect(screen.getAllByText('Email does not match the invitation')).toHaveLength(1);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should show a plain refusal in the alert, focused, with no field message', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invitation already used', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<AcceptInviteForm />);

    await activate(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invitation already used');
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should show the fallback, not the browser text, for a network failure', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR')
    );
    const user = userEvent.setup();
    render(<AcceptInviteForm />);

    await activate(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed to accept invitation. Please try again.');
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });

  it('should not show an invitation load failure through SaveError', async () => {
    vi.mocked(apiClient.get).mockRejectedValue(
      new APIClientError('Invitation not found', 'NOT_FOUND', 404)
    );

    render(<AcceptInviteForm />);

    expect(await screen.findByText('Invalid Invitation')).toBeInTheDocument();
    expect(
      screen.getByText('Invitation not found. Please check your email for the correct link.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should show an OAuth ?error= notice without an alert until activation fails, then replace it', async () => {
    nav.params = new URLSearchParams({
      token: 'tok-1',
      email: 'invitee@example.com',
      error: 'something_else',
    });
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invitation already used', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<AcceptInviteForm />);

    const notice = 'Unable to sign in. Please try again or set a password instead.';
    expect(await screen.findByText(notice)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    await activate(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Invitation already used');
    expect(screen.queryByText(notice)).not.toBeInTheDocument();
  });

  it('should clear the old alert when Activate Account is pressed again', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Invitation already used', 'CONFLICT', 409)
    );
    const user = userEvent.setup();
    render(<AcceptInviteForm />);
    await activate(user);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'Activate Account' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
