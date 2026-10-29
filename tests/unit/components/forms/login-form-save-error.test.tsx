// @vitest-environment happy-dom

/**
 * LoginForm save-error behaviour (t-950)
 *
 * A refused sign-in is shown through the shared `<SaveError>` directly before
 * the Sign In button, focused, and replaces an OAuth `?error=` notice rather
 * than appearing beside it. The unverified-email resend failure has its own
 * alert after the resend button.
 *
 * @see components/forms/login-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '@/components/forms/login-form';
import { authClient } from '@/lib/auth/client';
import { createMockRouter } from '@/tests/types/mocks';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signIn: { email: vi.fn() },
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
  EVENTS: { USER_LOGGED_IN: 'user_logged_in' },
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => nav.params),
}));

vi.mock('@/components/forms/oauth-buttons', () => ({ OAuthButtons: () => null }));

type SignInCallbacks = {
  onError: (ctx: {
    error: { code?: string; message?: string };
    response?: { status: number };
  }) => void;
};

/** Makes the next sign-in come back refused, the way better-auth's client reports it. */
function refuseSignIn(message: string, status = 401, code?: string) {
  vi.mocked(authClient.signIn.email).mockImplementation((async (
    _body: unknown,
    callbacks: SignInCallbacks
  ) => {
    callbacks.onError({ error: { code, message }, response: { status } });
    return { data: null, error: { code, message, status } };
  }) as never);
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function submitSignIn(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email'), 'test@example.com');
  await user.type(screen.getByLabelText('Password'), 'Password123!');
  await user.click(screen.getByRole('button', { name: 'Sign In' }));
}

describe('components/forms/login-form save errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue(createMockRouter());
    global.fetch = vi.fn();
  });

  it('should show a refused sign-in in an alert directly before Sign In, focused', async () => {
    refuseSignIn('Invalid email or password');
    const user = userEvent.setup();
    render(<LoginForm />);

    await submitSignIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid email or password');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Sign In' }));
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should show the rate-limit message for a 429 instead of the server text', async () => {
    refuseSignIn('Raw server text', 429);
    const user = userEvent.setup();
    render(<LoginForm />);

    await submitSignIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Too many sign-in attempts. Please wait a few minutes before trying again.'
    );
    expect(alert).not.toHaveTextContent('Raw server text');
  });

  it('should show an OAuth ?error= notice without an alert while no sign-in has failed', () => {
    nav.params = new URLSearchParams({
      error: 'access_denied',
      error_description: 'Google said no',
    });

    render(<LoginForm />);

    expect(screen.getByText('Google said no')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('should replace the OAuth notice, not duplicate it, once a sign-in fails', async () => {
    nav.params = new URLSearchParams({
      error: 'access_denied',
      error_description: 'Google said no',
    });
    refuseSignIn('Invalid email or password');
    const user = userEvent.setup();
    render(<LoginForm />);

    await submitSignIn(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Invalid email or password');
    expect(screen.queryByText('Google said no')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Invalid email or password/)).toHaveLength(1);
  });

  it('should clear the old alert when Sign In is pressed again, before the new attempt answers', async () => {
    refuseSignIn('First refusal');
    const user = userEvent.setup();
    render(<LoginForm />);
    await submitSignIn(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('First refusal');

    // The second attempt never answers: nothing may be left over from the first.
    vi.mocked(authClient.signIn.email).mockImplementation(() => new Promise(() => {}) as never);
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.queryByText('First refusal')).not.toBeInTheDocument();
  });

  it('should move to the new alert when a second refusal has the same message', async () => {
    refuseSignIn('Invalid email or password');
    const user = userEvent.setup();
    render(<LoginForm />);
    await submitSignIn(user);
    const first = await screen.findByRole('alert');
    await waitFor(() => expect(first).toHaveFocus());

    // Focus moves away, then the same refusal comes back.
    screen.getByLabelText('Email').focus();
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    const second = await screen.findByRole('alert');
    expect(second).toHaveTextContent('Invalid email or password');
    await waitFor(() => expect(second).toHaveFocus());
  });

  describe('unverified email', () => {
    async function reachUnverified(user: ReturnType<typeof userEvent.setup>) {
      refuseSignIn('Email not verified', 403, 'EMAIL_NOT_VERIFIED');
      render(<LoginForm />);
      await submitSignIn(user);
      return screen.findByRole('button', { name: 'Send verification email' });
    }

    it("should go by better-auth's code, not its wording", async () => {
      // A fork that rewords the refusal still gets the resend...
      refuseSignIn('Please confirm your address first', 403, 'EMAIL_NOT_VERIFIED');
      const user = userEvent.setup();
      const { unmount } = render(<LoginForm />);
      await submitSignIn(user);
      expect(
        await screen.findByRole('button', { name: 'Send verification email' })
      ).toBeInTheDocument();
      unmount();

      // ...and a message that says the words without the code does not.
      refuseSignIn('Email not verified', 401);
      render(<LoginForm />);
      await submitSignIn(user);
      expect(await screen.findByRole('alert')).toHaveTextContent('Email not verified');
      expect(
        screen.queryByRole('button', { name: 'Send verification email' })
      ).not.toBeInTheDocument();
    });

    it('should offer Send verification email between the sign-in alert and Sign In', async () => {
      const user = userEvent.setup();
      const sendButton = await reachUnverified(user);

      const signInAlert = screen.getByRole('alert');
      expect(signInAlert).toHaveTextContent('Email not verified');
      // alert -> [resend block] -> Sign In
      expect(signInAlert.nextElementSibling).toContainElement(sendButton);
      expect(
        signInAlert.compareDocumentPosition(screen.getByRole('button', { name: 'Sign In' })) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    it('should show the server message in its own alert after the resend button when the send is refused', async () => {
      vi.mocked(global.fetch).mockResolvedValue(jsonResponse({ message: 'Mailbox is full' }, 500));
      const user = userEvent.setup();
      const sendButton = await reachUnverified(user);

      await user.click(sendButton);

      const alert = await screen.findByText('Mailbox is full');
      const box = alert.closest('[role="alert"]');
      expect(box).not.toBeNull();
      expect(box!.previousElementSibling).toBe(sendButton);
      await waitFor(() => expect(box).toHaveFocus());
      // The sign-in refusal is still there, separately.
      expect(screen.getAllByRole('alert')).toHaveLength(2);
    });

    it('should fall back to the generic text when the refused send has no JSON message', async () => {
      vi.mocked(global.fetch).mockResolvedValue(
        new Response('<html>bad gateway</html>', { status: 502 })
      );
      const user = userEvent.setup();
      const sendButton = await reachUnverified(user);

      await user.click(sendButton);

      expect(await screen.findByText('Failed to send verification email')).toBeInTheDocument();
    });

    it('should show the fallback, not the browser text, when the send cannot reach the server', async () => {
      vi.mocked(global.fetch).mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      const sendButton = await reachUnverified(user);

      await user.click(sendButton);

      expect(
        await screen.findByText('Failed to send verification email. Please try again.')
      ).toBeInTheDocument();
      expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
    });
  });
});
