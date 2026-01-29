/**
 * ContactForm Component Tests
 *
 * Tests the ContactForm component which handles:
 * - Public contact form submission
 * - Form validation with Zod schema
 * - Honeypot spam prevention field
 * - Analytics tracking (contact_form_submitted)
 * - Success and error states
 * - API client integration
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/contact-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContactForm } from '@/components/forms/contact-form';

// Mock dependencies
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code: string;
    details?: Record<string, unknown>;
    constructor(message: string, code: string, details?: Record<string, unknown>) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.details = details;
    }
  },
}));

vi.mock('@/lib/analytics/events', () => ({
  useFormAnalytics: vi.fn(() => ({
    trackFormSubmitted: vi.fn(),
  })),
}));

/**
 * Test Suite: ContactForm Component
 */
describe('components/forms/contact-form', () => {
  let mockTrackFormSubmitted: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock analytics
    const { useFormAnalytics } = await import('@/lib/analytics/events');
    mockTrackFormSubmitted = vi.fn().mockResolvedValue(undefined) as unknown as ReturnType<
      typeof vi.fn
    >;
    vi.mocked(useFormAnalytics).mockReturnValue({
      trackFormSubmitted: mockTrackFormSubmitted,
    } as unknown as ReturnType<typeof useFormAnalytics>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render all form fields', () => {
      // Arrange & Act
      render(<ContactForm />);

      // Assert
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Subject')).toBeInTheDocument();
      expect(screen.getByLabelText('Message')).toBeInTheDocument();
    });

    it('should render honeypot field hidden', () => {
      // Arrange & Act
      const { container } = render(<ContactForm />);

      // Assert - Honeypot field should be hidden
      const honeypot = container.querySelector('input#website');
      expect(honeypot).toBeInTheDocument();
      const honeypotContainer = honeypot?.closest('div');
      expect(honeypotContainer?.className).toContain('opacity-0');
      expect(honeypotContainer?.getAttribute('aria-hidden')).toBe('true');
    });

    it('should render submit button', () => {
      // Arrange & Act
      render(<ContactForm />);

      // Assert
      const submitButton = screen.getByRole('button', { name: /send message/i });
      expect(submitButton).toBeInTheDocument();
      expect(submitButton).toHaveAttribute('type', 'submit');
    });

    it('should render fields with correct placeholders', () => {
      // Arrange & Act
      render(<ContactForm />);

      // Assert
      expect(screen.getByPlaceholderText('Your name')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('What is this about?')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Your message...')).toBeInTheDocument();
    });

    it('should not show error or success messages initially', () => {
      // Arrange & Act
      render(<ContactForm />);

      // Assert
      expect(screen.queryByText(/error|failed/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/message sent/i)).not.toBeInTheDocument();
    });
  });

  describe('form validation', () => {
    it('should show error for empty name', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ContactForm />);

      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act - Submit without filling name
      await user.click(submitButton);

      // Assert - Check for exact "Name is required" message
      await waitFor(() => {
        expect(screen.getByText('Name is required')).toBeInTheDocument();
      });
    });

    it('should show error for empty email', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act - Fill only name
      await user.type(nameInput, 'John Doe');
      await user.click(submitButton);

      // Assert - Check for exact "Email is required" message
      await waitFor(() => {
        expect(screen.getByText('Email is required')).toBeInTheDocument();
      });
    });

    it('should show error for invalid email', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act - Enter invalid email
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'invalid-email');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invalid email|valid email/i)).toBeInTheDocument();
      });
    });

    it('should show error for empty subject', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act - Fill name and email only
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/subject is required|required/i)).toBeInTheDocument();
      });
    });

    it('should show error for empty message', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act - Fill all except message
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.click(submitButton);

      // Assert - Message field has minimum length requirement
      await waitFor(() => {
        const messageError =
          screen.queryByText('Message is required') ||
          screen.queryByText(/message must be at least/i);
        expect(messageError).toBeInTheDocument();
      });
    });
  });

  describe('form submission', () => {
    it('should call apiClient.post with form data including honeypot', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockResolvedValue({
        success: true,
        data: { message: 'Message sent' },
      });

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act - Fill form and submit
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'This is a test message');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(apiClient.post).toHaveBeenCalledWith('/api/v1/contact', {
          body: {
            name: 'John Doe',
            email: 'john@example.com',
            subject: 'Test Subject',
            message: 'This is a test message',
            website: '', // Honeypot field should be empty
          },
        });
      });
    });

    it('should track contact_form_submitted on successful submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockResolvedValue({
        success: true,
        data: { message: 'Message sent' },
      });

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert - trackFormSubmitted should be called with 'contact'
      await waitFor(() => {
        expect(mockTrackFormSubmitted).toHaveBeenCalledWith('contact');
      });
    });

    it('should NOT track analytics on failed submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Failed to send', 'SEND_FAILED')
      );

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert - trackFormSubmitted should NOT be called on error
      await waitFor(() => {
        expect(screen.getByText(/failed to send/i)).toBeInTheDocument();
      });
      expect(mockTrackFormSubmitted).not.toHaveBeenCalled();
    });

    it('should show loading state during submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      // Make post hang
      vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();
      });
    });

    it('should disable form fields during submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockImplementation(() => new Promise(() => {}));

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(nameInput).toBeDisabled();
        expect(emailInput).toBeDisabled();
        expect(subjectInput).toBeDisabled();
        expect(messageInput).toBeDisabled();
      });
    });

    it('should show success state after submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockResolvedValue({
        success: true,
        data: { message: 'Message sent' },
      });

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert - Success message should be displayed
      await waitFor(() => {
        expect(screen.getByText(/message sent/i)).toBeInTheDocument();
      });
    });

    it('should clear form after successful submission', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockResolvedValue({
        success: true,
        data: { message: 'Message sent' },
      });

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert - Form fields should no longer be visible (replaced by success state)
      await waitFor(() => {
        expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Subject')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Message')).not.toBeInTheDocument();
      });
    });
  });

  describe('error handling', () => {
    it('should display error message on API client error', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Failed to send message', 'SEND_FAILED')
      );

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/failed to send message/i)).toBeInTheDocument();
      });
    });

    it('should display generic error on unexpected error', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(new Error('Network error'));

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/unexpected error occurred/i)).toBeInTheDocument();
      });
    });

    it('should re-enable form after error', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient, APIClientError } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockRejectedValue(
        new APIClientError('Failed to send', 'SEND_FAILED')
      );

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert - Fields should be re-enabled after error
      await waitFor(() => {
        expect(screen.getByText(/failed to send/i)).toBeInTheDocument();
      });
      expect(nameInput).not.toBeDisabled();
      expect(emailInput).not.toBeDisabled();
      expect(subjectInput).not.toBeDisabled();
      expect(messageInput).not.toBeDisabled();
      expect(submitButton).not.toBeDisabled();
    });
  });

  describe('success state', () => {
    it('should render success icon', async () => {
      // Arrange
      const user = userEvent.setup({ delay: null });
      const { apiClient } = await import('@/lib/api/client');

      vi.mocked(apiClient.post).mockResolvedValue({
        success: true,
        data: { message: 'Message sent' },
      });

      render(<ContactForm />);

      const nameInput = screen.getByLabelText('Name');
      const emailInput = screen.getByLabelText('Email');
      const subjectInput = screen.getByLabelText('Subject');
      const messageInput = screen.getByLabelText('Message');
      const submitButton = screen.getByRole('button', { name: /send message/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'john@example.com');
      await user.type(subjectInput, 'Test Subject');
      await user.type(messageInput, 'Test message');
      await user.click(submitButton);

      // Assert - Success state with message
      await waitFor(() => {
        expect(screen.getByText(/message sent/i)).toBeInTheDocument();
        expect(screen.getByText(/thank you for reaching out/i)).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('should have proper autocomplete attributes', () => {
      // Arrange & Act
      render(<ContactForm />);

      // Assert
      const emailInput = screen.getByLabelText('Email');
      expect(emailInput).toHaveAttribute('type', 'email');
      expect(emailInput).toHaveAttribute('autocomplete', 'email');
    });

    it('should have associated labels for all inputs', () => {
      // Arrange & Act
      render(<ContactForm />);

      // Assert - All fields should have labels
      expect(screen.getByLabelText('Name')).toBeInTheDocument();
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(screen.getByLabelText('Subject')).toBeInTheDocument();
      expect(screen.getByLabelText('Message')).toBeInTheDocument();
    });

    it('should have honeypot field with tabindex -1', () => {
      // Arrange & Act
      const { container } = render(<ContactForm />);

      // Assert
      const honeypot = container.querySelector('input#website');
      expect(honeypot).toHaveAttribute('tabindex', '-1');
      expect(honeypot).toHaveAttribute('autocomplete', 'off');
    });
  });
});
