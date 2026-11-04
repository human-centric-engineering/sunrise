// @vitest-environment happy-dom

/**
 * WaitlistLinkAction component tests (§125 t-977)
 *
 * The rule that matters: rendering the page sends nothing — mail scanners
 * open links before people do — and the press sends exactly the token the
 * link carried. A refused press shows the server's message beside the button.
 *
 * @see components/waitlist/waitlist-link-action.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockPost, MockAPIClientError } = vi.hoisted(() => {
  class MockAPIClientError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
    }
  }
  return { mockPost: vi.fn(), MockAPIClientError };
});

vi.mock('@/lib/api/client', () => ({
  apiClient: { post: mockPost },
  APIClientError: MockAPIClientError,
}));

import { WaitlistLinkAction } from '@/components/waitlist/waitlist-link-action';

const COPY = {
  buttonLabel: 'Confirm my address',
  doneMessage: 'Your address is confirmed.',
  failureMessage: 'Something went wrong.',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPost.mockResolvedValue({ confirmed: true });
});

describe('WaitlistLinkAction', () => {
  it('sends nothing until the button is pressed, then the entry and token', async () => {
    // Arrange
    const user = userEvent.setup();
    render(<WaitlistLinkAction action="confirm" entry="entry-1" token="tok" copy={COPY} />);

    // Assert — the visit alone did nothing
    expect(mockPost).not.toHaveBeenCalled();

    // Act
    await user.click(screen.getByRole('button', { name: 'Confirm my address' }));

    // Assert
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/waitlist/confirm', {
      body: { entry: 'entry-1', token: 'tok' },
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Your address is confirmed.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('a leave link posts only its token', async () => {
    const user = userEvent.setup();
    render(
      <WaitlistLinkAction
        action="leave"
        token="signed"
        copy={{ ...COPY, buttonLabel: 'Remove me' }}
      />
    );
    expect(mockPost).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Remove me' }));

    expect(mockPost).toHaveBeenCalledWith('/api/v1/waitlist/leave', { body: { token: 'signed' } });
  });

  it('shows the server’s refusal beside the button and keeps the button', async () => {
    // Arrange
    mockPost.mockRejectedValue(
      new MockAPIClientError('This link has expired or has already been used.', 'INVALID_TOKEN')
    );
    const user = userEvent.setup();
    render(<WaitlistLinkAction action="confirm" entry="entry-1" token="tok" copy={COPY} />);

    // Act
    await user.click(screen.getByRole('button', { name: 'Confirm my address' }));

    // Assert
    expect(
      await screen.findByText('This link has expired or has already been used.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm my address' })).toBeEnabled();
    expect(screen.queryByText('Your address is confirmed.')).not.toBeInTheDocument();
  });
});
