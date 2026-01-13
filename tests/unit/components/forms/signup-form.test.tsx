/**
 * SignupForm Component Tests
 *
 * Tests the SignupForm component which handles:
 * - Email/password registration with validation
 * - OAuth authentication integration
 * - Password strength meter
 * - Conditional redirect based on email verification
 * - OAuth error display from URL params
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/signup-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignupForm } from '@/components/forms/signup-form';

// Mock dependencies
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signUp: {
      email: vi.fn(),
    },
    getSession: vi.fn(),
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/signup'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Mock password strength calculator
vi.mock('@/lib/utils/password-strength', () => ({
  calculatePasswordStrength: vi.fn((password: string) => {
    if (password.length === 0) {
      return { percentage: 0, label: 'Weak', color: 'bg-red-500' };
    }
    if (password.length < 8) {
      return { percentage: 25, label: 'Weak', color: 'bg-red-500' };
    }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      return { percentage: 50, label: 'Fair', color: 'bg-orange-500' };
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      return { percentage: 75, label: 'Good', color: 'bg-yellow-500' };
    }
    return { percentage: 100, label: 'Strong', color: 'bg-green-500' };
  }),
}));

/**
 * Test Suite: SignupForm Component
 */
describe('components/forms/signup-form', () => {
  let mockRouter: { push: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.clearAllMocks();

    // Setup mock router
    const { useRouter } = await import('next/navigation');
    mockRouter = {
      push: vi.fn(),
      refresh: vi.fn(),
    };
    vi.mocked(useRouter).mockReturnValue({
      ...mockRouter,
      replace: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    } as unknown as ReturnType<typeof useRouter>);

    // Default: no URL params
    const { useSearchParams } = await import('next/navigation');
    vi.mocked(useSearchParams).mockReturnValue(
      new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('should render name input field', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const nameInput = screen.getByLabelText(/full name/i);
      expect(nameInput).toBeInTheDocument();
      expect(nameInput).toHaveAttribute('type', 'text');
      expect(nameInput).toHaveAttribute('placeholder', 'John Doe');
    });

    it('should render email input field', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const emailInput = screen.getByLabelText(/email/i);
      expect(emailInput).toBeInTheDocument();
      expect(emailInput).toHaveAttribute('type', 'email');
    });

    it('should render password input field', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const passwordInput = screen.getByLabelText(/^password$/i);
      expect(passwordInput).toBeInTheDocument();
    });

    it('should render confirm password input field', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const confirmInput = screen.getByLabelText(/confirm password/i);
      expect(confirmInput).toBeInTheDocument();
    });

    it('should render create account button', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const submitButton = screen.getByRole('button', { name: /create account/i });
      expect(submitButton).toBeInTheDocument();
      expect(submitButton).toHaveAttribute('type', 'submit');
    });

    it('should render OAuth buttons', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const googleButton = screen.getByRole('button', { name: /google/i });
      expect(googleButton).toBeInTheDocument();
    });

    it('should render password requirements hint', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      expect(screen.getByText(/must be at least 8 characters/i)).toBeInTheDocument();
    });

    it('should not show error message initially', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const errorElement = screen.queryByText(/failed|error/i);
      expect(errorElement).not.toBeInTheDocument();
    });
  });

  describe('form validation', () => {
    it('should show error for empty name', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SignupForm />);

      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act: Fill all except name
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert - must be specific to match validation error, not label
      await waitFor(() => {
        expect(screen.getByText(/name is required/i)).toBeInTheDocument();
      });
    });

    it('should show error for invalid email format', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'invalid-email');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/invalid email/i)).toBeInTheDocument();
      });
    });

    it('should show error for password too short', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'short');
      await user.click(submitButton);

      // Assert - validation error starts with "Password must be" (vs hint which starts with "Must be")
      await waitFor(() => {
        expect(screen.getByText(/password must be at least 8 characters/i)).toBeInTheDocument();
      });
    });

    it('should show error for password mismatch', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'DifferentPassword123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(
          screen.getByText(/passwords don't match|passwords do not match/i)
        ).toBeInTheDocument();
      });
    });
  });

  describe('password strength meter', () => {
    it('should show password strength indicator when typing', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<SignupForm />);

      const passwordInput = screen.getByLabelText(/^password$/i);

      // Act
      await user.type(passwordInput, 'Password123!');

      // Assert: PasswordStrength component should be visible
      await waitFor(() => {
        // The password strength component should render when password is not empty
        const strengthText = screen.queryByText(/weak|fair|good|strong/i);
        expect(strengthText).toBeInTheDocument();
      });
    });
  });

  describe('form submission', () => {
    it('should call authClient.signUp.email with form data', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(authClient.signUp.email).toHaveBeenCalledWith(
          {
            name: 'John Doe',
            email: 'test@example.com',
            password: 'Password123!',
          },
          expect.any(Object)
        );
      });
    });

    it('should show loading state during submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signUp.email).mockImplementation(() => new Promise(() => {}));

      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /creating account/i })).toBeInTheDocument();
      });
    });

    it('should disable inputs during submission', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signUp.email).mockImplementation(() => new Promise(() => {}));

      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(nameInput).toBeDisabled();
        expect(emailInput).toBeDisabled();
        expect(passwordInput).toBeDisabled();
        expect(confirmInput).toBeDisabled();
      });
    });

    it('should redirect to dashboard when session exists after signup', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signUp.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onSuccess?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onSuccess>>[0]
        );
      });
      vi.mocked(authClient.getSession).mockResolvedValue({
        data: { user: { id: '1' } },
      } as unknown as Awaited<ReturnType<typeof authClient.getSession>>);

      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/dashboard');
      });
    });

    it('should redirect to verify-email when no session (verification required)', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signUp.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onSuccess?.(
          {} as unknown as Parameters<NonNullable<typeof callbacks.onSuccess>>[0]
        );
      });
      vi.mocked(authClient.getSession).mockResolvedValue({ data: null } as unknown as Awaited<
        ReturnType<typeof authClient.getSession>
      >);

      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(mockRouter.push).toHaveBeenCalledWith('/verify-email?email=test%40example.com');
      });
    });
  });

  describe('error handling', () => {
    it('should display error message on failed signup', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signUp.email).mockImplementation(async (_data, callbacks) => {
        void callbacks?.onError?.({
          error: { message: 'Email already registered' },
        } as unknown as Parameters<NonNullable<typeof callbacks.onError>>[0]);
      });

      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'existing@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/email already registered/i)).toBeInTheDocument();
      });
    });

    it('should display OAuth error from URL params', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');

      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(
          'error=access_denied&error_description=User cancelled signup'
        ) as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SignupForm />);

      // Assert
      expect(screen.getByText(/user cancelled signup/i)).toBeInTheDocument();
    });

    it('should display generic OAuth error when description missing', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');

      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams('error=server_error') as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SignupForm />);

      // Assert
      expect(screen.getByText(/oauth authentication failed/i)).toBeInTheDocument();
    });

    it('should handle unexpected errors gracefully', async () => {
      // Arrange
      const user = userEvent.setup();
      const { authClient } = await import('@/lib/auth/client');

      vi.mocked(authClient.signUp.email).mockRejectedValue(new Error('Network error'));

      render(<SignupForm />);

      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);
      const submitButton = screen.getByRole('button', { name: /create account/i });

      // Act
      await user.type(nameInput, 'John Doe');
      await user.type(emailInput, 'test@example.com');
      await user.type(passwordInput, 'Password123!');
      await user.type(confirmInput, 'Password123!');
      await user.click(submitButton);

      // Assert
      await waitFor(() => {
        expect(screen.getByText(/unexpected error/i)).toBeInTheDocument();
      });
    });
  });

  describe('accessibility', () => {
    it('should have proper autocomplete attributes', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      const nameInput = screen.getByLabelText(/full name/i);
      const emailInput = screen.getByLabelText(/email/i);
      const passwordInput = screen.getByLabelText(/^password$/i);
      const confirmInput = screen.getByLabelText(/confirm password/i);

      expect(nameInput).toHaveAttribute('autocomplete', 'name');
      expect(emailInput).toHaveAttribute('autocomplete', 'email');
      expect(passwordInput).toHaveAttribute('autocomplete', 'new-password');
      expect(confirmInput).toHaveAttribute('autocomplete', 'new-password');
    });

    it('should have associated labels for all inputs', () => {
      // Arrange & Act
      render(<SignupForm />);

      // Assert
      expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    });
  });
});
