// @vitest-environment happy-dom

/**
 * Verify-email pending page save-error behaviour (t-950)
 *
 * A failed resend is shown through the shared `<SaveError>` directly after the
 * resend button, focused, in the page's own words: the browser's text for a
 * network failure never reaches the screen.
 *
 * @see app/(auth)/verify-email/verify-email-content.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VerifyEmailClientContent } from '@/app/(auth)/verify-email/verify-email-content';

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(() => nav.params),
}));

const FALLBACK = 'Failed to resend verification email. Please try again.';

describe('app/(auth)/verify-email save errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nav.params = new URLSearchParams({ email: 'user@example.com' });
  });

  it('should show a refused resend directly after the resend button, focused', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'Rate limited' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    const user = userEvent.setup();
    render(<VerifyEmailClientContent />);

    const button = screen.getByRole('button', { name: 'Resend verification email' });
    await user.click(button);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(FALLBACK);
    expect(alert.previousElementSibling).toBe(button);
    await waitFor(() => expect(alert).toHaveFocus());
    expect(screen.queryByText(/sent successfully/i)).not.toBeInTheDocument();
  });

  it('should show the fallback, not the browser text, when the request cannot reach the server', async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const user = userEvent.setup();
    render(<VerifyEmailClientContent />);

    await user.click(screen.getByRole('button', { name: 'Resend verification email' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(FALLBACK);
    expect(screen.queryByText('Failed to fetch')).not.toBeInTheDocument();
  });

  it('should clear the old alert when resend is pressed again', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 500 }));
    const user = userEvent.setup();
    render(<VerifyEmailClientContent />);
    const button = screen.getByRole('button', { name: 'Resend verification email' });
    await user.click(button);
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    global.fetch = vi.fn(() => new Promise<Response>(() => {}));
    await user.click(screen.getByRole('button', { name: /Resend verification email|Sending/ }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('should show no alert and no resend button when there is no email in the URL', () => {
    nav.params = new URLSearchParams();

    render(<VerifyEmailClientContent />);

    expect(screen.queryByRole('button', { name: /resend/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
