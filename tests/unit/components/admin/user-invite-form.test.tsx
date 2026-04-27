/**
 * UserInviteForm Component Tests
 *
 * Tests the UserInviteForm component which handles:
 * - Form rendering with name, email, and role fields
 * - Zod/RHF validation for required fields and format checks
 * - Successful invite submission (transitions to success card)
 * - API error handling (APIClientError and generic errors)
 * - Loading state (button text + disabled inputs)
 * - Success card actions (Invite Another, Back to Users)
 * - Clipboard copy with copied confirmation and timeout
 * - Conditional rendering based on emailStatus
 *
 * @see components/admin/user-invite-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserInviteForm } from '@/components/admin/user-invite-form';

// ---- mock dependencies ------------------------------------------------

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
    constructor(
      message: string,
      code?: string,
      status?: number,
      details?: Record<string, unknown>
    ) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.status = status;
      this.details = details;
    }
  },
}));

vi.mock('@/lib/api/endpoints', () => ({
  API: {
    USERS: {
      INVITE: '/api/v1/users/invite',
    },
  },
}));

// ---- helpers -----------------------------------------------------------

function buildSuccessResponse(
  overrides: {
    emailStatus?: 'sent' | 'failed' | 'disabled' | 'pending';
    link?: string;
  } = {}
) {
  return {
    message: 'Invitation sent successfully',
    invitation: {
      email: 'jane@example.com',
      name: 'Jane Doe',
      role: 'USER',
      invitedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-08T00:00:00Z',
      link: overrides.link,
    },
    emailStatus: overrides.emailStatus ?? 'sent',
  };
}

/** Fill and submit the invite form using real-timer userEvent */
async function submitInviteForm(
  user: ReturnType<typeof userEvent.setup>,
  name = 'Jane Doe',
  email = 'jane@example.com'
) {
  await user.type(screen.getByLabelText('Name'), name);
  await user.type(screen.getByLabelText('Email'), email);
  await user.click(screen.getByRole('button', { name: /send invitation/i }));
}

/** Render the component with a successful API response and wait for the success card */
async function renderSuccessCard(
  overrides: {
    emailStatus?: 'sent' | 'failed' | 'disabled' | 'pending';
    link?: string;
  } = {}
) {
  const user = userEvent.setup();
  const { apiClient } = await import('@/lib/api/client');
  vi.mocked(apiClient.post).mockResolvedValue(buildSuccessResponse(overrides));

  render(<UserInviteForm />);
  await submitInviteForm(user);

  await waitFor(() => {
    expect(screen.getByText('Invitation Sent')).toBeInTheDocument();
  });

  return user;
}

// ---- test suite --------------------------------------------------------

describe('components/admin/user-invite-form', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- rendering -------------------------------------------------------

  describe('rendering', () => {
    it('should render form with name, email, role fields and Send Invitation button', () => {
      // Arrange & Act
      render(<UserInviteForm />);

      // Assert: key form elements
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByText('Role')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send invitation/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('should default Role select to USER', () => {
      // Arrange & Act
      render(<UserInviteForm />);

      // Assert: The Select trigger (combobox) shows "User" — the display label for USER
      expect(screen.getByRole('combobox')).toHaveTextContent('User');
    });
  });

  // ---- validation ------------------------------------------------------

  describe('validation', () => {
    it('should show "Name is required" when submitting with empty name', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserInviteForm />);

      // Act: leave name blank, fill valid email, submit
      await user.type(screen.getByLabelText('Email'), 'test@example.com');
      await user.click(screen.getByRole('button', { name: /send invitation/i }));

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeInTheDocument();
      });
    });

    it('should show "Invalid email address" when submitting a bad email format', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserInviteForm />);

      // Act: fill name, type invalid email, blur to trigger onTouched validation
      await user.type(screen.getByLabelText('Name'), 'Test User');
      await user.type(screen.getByLabelText('Email'), 'not-an-email');
      await user.tab(); // blur email field — triggers onTouched mode

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Invalid email address')).toBeInTheDocument();
      });
    });
  });

  // ---- navigation ------------------------------------------------------

  describe('navigation', () => {
    it('should navigate to /admin/users when Cancel button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserInviteForm />);

      // Act
      await user.click(screen.getByRole('button', { name: /cancel/i }));

      // Assert
      expect(mockPush).toHaveBeenCalledWith('/admin/users');
    });

    it('should navigate to /admin/users when Back to Users button is clicked on form view', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<UserInviteForm />);

      // Act: click the ghost back button at the top of the form view
      const buttons = screen.getAllByRole('button', { name: /back to users/i });
      await user.click(buttons[0]);

      // Assert
      expect(mockPush).toHaveBeenCalledWith('/admin/users');
    });
  });

  // ---- form submission -------------------------------------------------

  describe('form submission', () => {
    it('should call apiClient.post with correct payload and transition to success card on successful submit', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockResolvedValue(buildSuccessResponse());

      render(<UserInviteForm />);

      // Act
      await submitInviteForm(user);

      // Assert: API called with correct payload
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith('/api/v1/users/invite', {
          body: { name: 'Jane Doe', email: 'jane@example.com', role: 'USER' },
        });
      });

      // Assert: success card shown
      await waitFor(() => {
        expect(screen.getByText('Invitation Sent')).toBeInTheDocument();
      });
    });

    it('should show loading state (Sending... / disabled inputs) while request is in flight', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      // Never-resolving promise so we stay in loading state
      vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => undefined));

      render(<UserInviteForm />);

      await user.type(screen.getByLabelText('Name'), 'Jane Doe');
      await user.type(screen.getByLabelText('Email'), 'jane@example.com');

      // Act
      await user.click(screen.getByRole('button', { name: /send invitation/i }));

      // Assert: button text changes and inputs become disabled
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled();
        expect(screen.getByLabelText('Name')).toBeDisabled();
        expect(screen.getByLabelText('Email')).toBeDisabled();
      });
    });

    it('should show APIClientError message in error banner when API returns APIClientError', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient, APIClientError } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Email already has a pending invitation', 'CONFLICT', 409)
      );

      render(<UserInviteForm />);

      // Act
      await submitInviteForm(user);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('Email already has a pending invitation')).toBeInTheDocument();
      });
    });

    it('should show "An unexpected error occurred" in error banner for unknown errors', async () => {
      // Arrange
      const user = userEvent.setup();
      const { apiClient } = await import('@/lib/api/client');
      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network failure'));

      render(<UserInviteForm />);

      // Act
      await submitInviteForm(user);

      // Assert
      await waitFor(() => {
        expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
      });
    });
  });

  // ---- success card ----------------------------------------------------

  describe('success card', () => {
    it('should reset form and return to form view when Invite Another is clicked', async () => {
      // Arrange
      const user = await renderSuccessCard();

      // Act
      await user.click(screen.getByRole('button', { name: /invite another/i }));

      // Assert: form view is shown again with empty fields
      await waitFor(() => {
        expect(screen.getByLabelText('Name')).toBeInTheDocument();
        expect(screen.getByLabelText('Name')).toHaveValue('');
        expect(screen.getByLabelText('Email')).toHaveValue('');
      });
    });

    it('should navigate to /admin/users when Back to Users button is clicked on success card footer', async () => {
      // Arrange
      const user = await renderSuccessCard();

      // Act: the footer "Back to Users" button (outline variant in CardFooter)
      const backButtons = screen.getAllByRole('button', { name: /back to users/i });
      // The ghost button at top + the outline button in the footer
      await user.click(backButtons[backButtons.length - 1]);

      // Assert
      expect(mockPush).toHaveBeenCalledWith('/admin/users');
    });

    it('should call navigator.clipboard.writeText with the invite link when copy button is clicked', async () => {
      // Arrange: spy on navigator.clipboard.writeText (happy-dom exposes clipboard)
      const clipboardSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

      const user = await renderSuccessCard({
        link: 'https://example.com/invite/token-abc',
      });

      // Act
      await user.click(screen.getByRole('button', { name: /copy link/i }));

      // Assert
      await waitFor(() => {
        expect(clipboardSpy).toHaveBeenCalledWith('https://example.com/invite/token-abc');
      });
    });

    it('should show manual share hint when emailStatus is not "sent"', async () => {
      // Arrange & Act
      await renderSuccessCard({
        emailStatus: 'disabled',
        link: 'https://example.com/invite/token-abc',
      });

      // Assert: manual share hint is visible
      expect(
        screen.getByText('You can share this link manually with the invited user.')
      ).toBeInTheDocument();
    });

    it('should hide manual share hint when emailStatus is "sent"', async () => {
      // Arrange & Act
      await renderSuccessCard({
        emailStatus: 'sent',
        link: 'https://example.com/invite/token-abc',
      });

      // Assert: manual share hint is not shown
      expect(
        screen.queryByText('You can share this link manually with the invited user.')
      ).not.toBeInTheDocument();
    });

    // ---- copied confirmation (isolated with fake timers) ---------------

    it('should show "Link copied to clipboard!" after copy and hide it after 2 seconds', async () => {
      // Arrange: spy on clipboard and render success card (uses real timers)
      const clipboardSpy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

      await renderSuccessCard({
        link: 'https://example.com/invite/token-abc',
      });

      // Switch to fake timers BEFORE clicking copy so the component's
      // setTimeout(() => setCopied(false), 2000) is registered under fake timers
      vi.useFakeTimers();

      // Act: click copy button — registers the 2s timeout under fake timers
      fireEvent.click(screen.getByRole('button', { name: /copy link/i }));

      // Flush the clipboard.writeText promise under fake timers
      await act(async () => {
        await Promise.resolve();
      });

      // Assert: clipboard was called and confirmation text is visible
      expect(clipboardSpy).toHaveBeenCalledWith('https://example.com/invite/token-abc');
      expect(screen.getByText('Link copied to clipboard!')).toBeInTheDocument();

      // Act: advance past the 2-second timeout
      await act(async () => {
        vi.advanceTimersByTime(2001);
      });

      // Assert: confirmation message gone
      expect(screen.queryByText('Link copied to clipboard!')).not.toBeInTheDocument();

      vi.useRealTimers();
    });
  });
});
