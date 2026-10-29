// @vitest-environment happy-dom

/**
 * ContactForm save-error behaviour (t-950)
 *
 * Field-level validation refusals land under their fields with focus on the
 * first one in page order; a plain refusal shows its server message directly
 * before the submit button.
 *
 * @see components/forms/contact-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContactForm } from '@/components/forms/contact-form';
import { apiClient, APIClientError } from '@/lib/api/client';

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { post: vi.fn() },
}));

vi.mock('@/lib/analytics/events', () => ({
  useFormAnalytics: vi.fn(() => ({ trackFormSubmitted: vi.fn() })),
}));

async function send(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Name'), 'Jane');
  await user.type(screen.getByLabelText('Email'), 'jane@example.com');
  await user.type(screen.getByLabelText('Subject'), 'Hello there');
  await user.type(screen.getByLabelText('Message'), 'A message that is long enough.');
  await user.click(screen.getByRole('button', { name: 'Send Message' }));
}

describe('components/forms/contact-form save errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should put each named-field message under its field and focus the first in page order', async () => {
    // The server names subject before email; the page has email first.
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Validation failed', 'VALIDATION_ERROR', 400, {
        errors: [
          { path: 'subject', message: 'Subject looks like spam' },
          { path: 'email', message: 'Email domain is blocked' },
        ],
      })
    );
    const user = userEvent.setup();
    render(<ContactForm />);

    await send(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('2 fields need fixing.');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Send Message' }));
    const email = screen.getByLabelText('Email');
    const subject = screen.getByLabelText('Subject');
    expect(email.closest('.space-y-2')).toContainElement(
      screen.getByText('Email domain is blocked')
    );
    expect(subject.closest('.space-y-2')).toContainElement(
      screen.getByText('Subject looks like spam')
    );
    await waitFor(() => expect(email).toHaveFocus());
  });

  it('should show a plain refusal directly before Send Message, focused', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Too many messages, slow down', 'RATE_LIMITED', 429)
    );
    const user = userEvent.setup();
    render(<ContactForm />);

    await send(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many messages, slow down');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Send Message' }));
    await waitFor(() => expect(alert).toHaveFocus());
  });

  it('should show the fallback, not the browser text, when the request cannot be made', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(
      new APIClientError('Failed to fetch', 'NETWORK_ERROR')
    );
    const user = userEvent.setup();
    render(<ContactForm />);

    await send(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('An unexpected error occurred. Please try again.');
    expect(alert).not.toHaveTextContent('Failed to fetch');
  });

  it('should clear the previous alert when Send Message is pressed again', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new APIClientError('Nope', 'FORBIDDEN', 403));
    const user = userEvent.setup();
    render(<ContactForm />);
    await send(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');

    vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));
    await user.click(screen.getByRole('button', { name: 'Send Message' }));

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
});
