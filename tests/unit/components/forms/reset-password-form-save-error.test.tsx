// @vitest-environment happy-dom

/**
 * ResetPasswordForm save-error behaviour (t-950)
 *
 * Request step: a refused request shows the fallback directly before Send
 * reset link. Complete step: an invalid/expired-link refusal shows the
 * link-expired message plus a way to request a new link; any other refusal
 * shows its own message without that link.
 *
 * @see components/forms/reset-password-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResetPasswordForm } from '@/components/forms/reset-password-form';
import { authClient } from '@/lib/auth/client';
import { createMockRouter } from '@/tests/types/mocks';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('@/lib/auth/client', () => ({
  authClient: { resetPassword: vi.fn() },
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/analytics/events', () => ({
  useFormAnalytics: vi.fn(() => ({ trackFormSubmitted: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => nav.params),
}));

type ResetCallbacks = {
  onError: (ctx: { error: { code?: string; message?: string } }) => void;
};

/** What better-auth sends for an expired, used or unknown token alike. */
const INVALID_TOKEN = ['Invalid token', 'INVALID_TOKEN'] as const;

function refuseReset(message: string, code?: string) {
  vi.mocked(authClient.resetPassword).mockImplementation((async (
    _body: unknown,
    callbacks: ResetCallbacks
  ) => {
    callbacks.onError({ error: { code, message } });
    return { data: null, error: { code, message } };
  }) as never);
}

async function submitNewPassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('New Password'), 'Password123!');
  await user.type(screen.getByLabelText('Confirm Password'), 'Password123!');
  await user.click(screen.getByRole('button', { name: 'Reset password' }));
}

describe('components/forms/reset-password-form save errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams();
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue(createMockRouter());
  });

  describe('request step', () => {
    it('should show the fallback directly before Send reset link when the request is refused', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ message: 'Server exploded' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        })
      );
      const user = userEvent.setup();
      render(<ResetPasswordForm />);

      await user.type(screen.getByLabelText('Email'), 'test@example.com');
      await user.click(screen.getByRole('button', { name: 'Send reset link' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Failed to send reset email. Please try again.');
      expect(alert.nextElementSibling).toBe(
        screen.getByRole('button', { name: 'Send reset link' })
      );
      await waitFor(() => expect(alert).toHaveFocus());
    });

    it('should show the fallback, not the browser text, when the request cannot reach the server', async () => {
      global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      render(<ResetPasswordForm />);

      await user.type(screen.getByLabelText('Email'), 'test@example.com');
      await user.click(screen.getByRole('button', { name: 'Send reset link' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Failed to send reset email. Please try again.'
      );
      expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
    });
  });

  describe('complete step', () => {
    beforeEach(() => {
      nav.params = new URLSearchParams({ token: 'tok-123' });
    });

    it('should show the link-expired message and a request-new-link action for an invalid token', async () => {
      refuseReset(...INVALID_TOKEN);
      const user = userEvent.setup();
      render(<ResetPasswordForm />);

      await submitNewPassword(user);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('This reset link is invalid or has expired.');
      const link = screen.getByRole('link', { name: 'Request new reset link' });
      expect(link).toHaveAttribute('href', '/reset-password');
      // alert -> Request new reset link -> Reset password
      expect(alert.nextElementSibling).toBe(link);
      expect(link.nextElementSibling).toBe(screen.getByRole('button', { name: 'Reset password' }));
      await waitFor(() => expect(alert).toHaveFocus());
    });

    it("should go by better-auth's code, not its wording", async () => {
      // A reworded refusal with the code still offers a new link...
      refuseReset('That link has been used', 'INVALID_TOKEN');
      const user = userEvent.setup();
      const { unmount } = render(<ResetPasswordForm />);
      await submitNewPassword(user);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        'This reset link is invalid or has expired.'
      );
      expect(screen.getByRole('link', { name: 'Request new reset link' })).toBeInTheDocument();
      unmount();

      // ...and a message that merely says "invalid", without it, does not.
      refuseReset('Password is invalid: too short', 'PASSWORD_TOO_SHORT');
      render(<ResetPasswordForm />);
      await submitNewPassword(user);
      expect(await screen.findByRole('alert')).toHaveTextContent('Password is invalid: too short');
      expect(
        screen.queryByRole('link', { name: 'Request new reset link' })
      ).not.toBeInTheDocument();
    });

    it('should show any other refusal as sent, without the request-new-link action', async () => {
      refuseReset('Password is too common');
      const user = userEvent.setup();
      render(<ResetPasswordForm />);

      await submitNewPassword(user);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Password is too common');
      expect(
        screen.queryByRole('link', { name: 'Request new reset link' })
      ).not.toBeInTheDocument();
      expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Reset password' }));
    });

    it('should drop the request-new-link action when the next press clears the failure', async () => {
      refuseReset(...INVALID_TOKEN);
      const user = userEvent.setup();
      render(<ResetPasswordForm />);
      await submitNewPassword(user);
      expect(
        await screen.findByRole('link', { name: 'Request new reset link' })
      ).toBeInTheDocument();

      vi.mocked(authClient.resetPassword).mockImplementation(() => new Promise(() => {}) as never);
      await user.click(screen.getByRole('button', { name: 'Reset password' }));

      await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
      expect(
        screen.queryByRole('link', { name: 'Request new reset link' })
      ).not.toBeInTheDocument();
    });
  });
});
