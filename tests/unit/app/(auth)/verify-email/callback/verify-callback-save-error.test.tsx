// @vitest-environment happy-dom

/**
 * Verify-email callback page save-error behaviour (t-950)
 *
 * A failed resend is shown through the shared `<SaveError>` directly after the
 * resend button, focused. A refused response gives the server's own `message`;
 * a network failure or an unreadable body gives the page's fallback.
 *
 * @see app/(auth)/verify-email/callback/verify-callback-content.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VerifyCallbackClientContent } from '@/app/(auth)/verify-email/callback/verify-callback-content';
import { createMockRouter } from '@/tests/types/mocks';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(),
  useSearchParams: vi.fn(() => nav.params),
}));

const FALLBACK = 'Failed to resend verification email. Please try again.';

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function pressResend(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Email Address'), 'user@example.com');
  const button = screen.getByRole('button', { name: 'Resend Verification Email' });
  await user.click(button);
  return button;
}

describe('app/(auth)/verify-email/callback save errors', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams({ error: 'invalid_token' });
    const { useRouter } = await import('next/navigation');
    vi.mocked(useRouter).mockReturnValue(createMockRouter());
  });

  it("should show the server's message, directly after the resend button and focused, when the response is refused", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'USER_NOT_FOUND', message: 'No account for that address' }, 404)
      );
    const user = userEvent.setup();
    render(<VerifyCallbackClientContent />);

    const button = await pressResend(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No account for that address');
    expect(alert.previousElementSibling).toBe(button);
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should show the fallback when the refused response has no readable message', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const user = userEvent.setup();
    render(<VerifyCallbackClientContent />);

    await pressResend(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(FALLBACK);
  });

  it('should show the fallback, not the browser text, when the request cannot reach the server', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<VerifyCallbackClientContent />);

    await pressResend(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(FALLBACK);
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
  });

  it('should clear the old alert when resend is pressed again', async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ message: 'Try later' }, 429));
    const user = userEvent.setup();
    render(<VerifyCallbackClientContent />);
    await pressResend(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Try later');

    global.fetch = vi.fn(() => new Promise<Response>(() => {}));
    await user.click(screen.getByRole('button', { name: /Resend Verification Email|Sending/ }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
