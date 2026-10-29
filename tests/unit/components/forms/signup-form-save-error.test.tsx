// @vitest-environment happy-dom

/**
 * SignupForm save-error behaviour (t-950)
 *
 * A refused sign-up is shown through the shared `<SaveError>` directly before
 * Create Account, focused. An OAuth `?error=` notice shows through FormError
 * until a sign-up fails, then gives way to it.
 *
 * @see components/forms/signup-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupForm } from '@/components/forms/signup-form';
import { authClient } from '@/lib/auth/client';
import { createMockRouter } from '@/tests/types/mocks';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signUp: { email: vi.fn() },
    getSession: vi.fn().mockResolvedValue({ data: null }),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/analytics', () => ({
  useAnalytics: vi.fn(() => ({
    track: vi.fn().mockResolvedValue(undefined),
    identify: vi.fn().mockResolvedValue(undefined),
  })),
  EVENTS: { USER_SIGNED_UP: 'user_signed_up' },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => nav.params),
}));

vi.mock('@/components/forms/oauth-buttons', () => ({ OAuthButtons: () => null }));

type SignUpCallbacks = { onError: (ctx: { error: { message?: string } }) => void };

function refuseSignUp(message: string) {
  vi.mocked(authClient.signUp.email).mockImplementation((async (
    _body: unknown,
    callbacks: SignUpCallbacks
  ) => {
    callbacks.onError({ error: { message } });
    return { data: null, error: { message } };
  }) as never);
}

async function submitSignUp(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Full Name'), 'John Doe');
  await user.type(screen.getByLabelText('Email'), 'john@example.com');
  await user.type(screen.getByLabelText('Password'), 'Password123!');
  await user.type(screen.getByLabelText('Confirm Password'), 'Password123!');
  await user.click(screen.getByRole('button', { name: 'Create Account' }));
}

describe('components/forms/signup-form save errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue(createMockRouter());
  });

  it('should show a refused sign-up in an alert directly before Create Account, focused', async () => {
    refuseSignUp('User already exists');
    const user = userEvent.setup();
    render(<SignupForm />);

    await submitSignUp(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('User already exists');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Create Account' }));
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should show the generic message when the refusal carries none', async () => {
    refuseSignUp('');
    const user = userEvent.setup();
    render(<SignupForm />);

    await submitSignUp(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Failed to create account. Please try again.'
    );
  });

  it('should show an OAuth ?error= notice without an alert until a sign-up fails', () => {
    nav.params = new URLSearchParams({ error: 'oauth', error_description: 'Provider is down' });

    render(<SignupForm />);

    expect(screen.getByText('Provider is down')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should replace the OAuth notice with the sign-up refusal rather than show both', async () => {
    nav.params = new URLSearchParams({ error: 'oauth', error_description: 'Provider is down' });
    refuseSignUp('User already exists');
    const user = userEvent.setup();
    render(<SignupForm />);

    await submitSignUp(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('User already exists');
    expect(screen.queryByText('Provider is down')).not.toBeInTheDocument();
  });

  it('should clear the old alert when Create Account is pressed again', async () => {
    refuseSignUp('User already exists');
    const user = userEvent.setup();
    render(<SignupForm />);
    await submitSignUp(user);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    vi.mocked(authClient.signUp.email).mockImplementation(() => new Promise(() => {}) as never);
    await user.click(screen.getByRole('button', { name: 'Create Account' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
