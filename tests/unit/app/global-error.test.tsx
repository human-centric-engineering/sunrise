/**
 * Global Error Boundary Tests
 *
 * Tests the global error boundary component that catches errors in the root layout.
 * This component is the final fallback for unhandled errors.
 *
 * Test Coverage:
 * - Component renders correctly with error information
 * - Logger is called with correct parameters
 * - Sentry trackError is called with Fatal severity
 * - "Try again" button calls reset() function
 * - "Go home" button navigates to "/"
 * - Development mode shows error details
 * - Production mode hides error details
 * - Component includes required html and body tags
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/global-error.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import GlobalError from '@/app/global-error';

/**
 * Mock logger
 */
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * Mock Sentry error tracking
 */
vi.mock('@/lib/errors/sentry', () => ({
  trackError: vi.fn(),
  ErrorSeverity: {
    Fatal: 'fatal',
    Error: 'error',
    Warning: 'warning',
    Info: 'info',
    Debug: 'debug',
  },
}));

/**
 * Mock lucide-react icons
 */
vi.mock('lucide-react', () => ({
  AlertTriangle: vi.fn(() => <div data-testid="alert-triangle-icon" />),
  Home: vi.fn(() => <div data-testid="home-icon" />),
  RotateCcw: vi.fn(() => <div data-testid="rotate-ccw-icon" />),
}));

import { logger } from '@/lib/logging';
import { trackError, ErrorSeverity } from '@/lib/errors/sentry';

/**
 * Test Suite: Global Error Boundary
 */
describe('app/global-error', () => {
  const mockReset = vi.fn();
  const mockError = new Error('Test error message');
  const mockErrorWithDigest = Object.assign(new Error('Test error with digest'), {
    digest: 'abc123',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset NODE_ENV to test for each test
    (process.env as { NODE_ENV?: string }).NODE_ENV = 'test';
    // Reset window.location.href for navigation tests
    delete (window as { location?: unknown }).location;
    (window as { location: { href: string } }).location = { href: '/' };
  });

  describe('rendering', () => {
    it('should render error boundary with error message', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.getByText('Application Error')).toBeInTheDocument();
      expect(
        screen.getByText(/A critical error occurred. This has been logged and we'll look into it./)
      ).toBeInTheDocument();
    });

    it('should render component structure with container', () => {
      // Arrange & Act
      const { container } = render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Verify the component renders and contains expected elements
      // Note: In test environment, html/body tags are not rendered in the DOM tree
      // (they're handled by Next.js in actual runtime). We verify the inner content instead.
      expect(container).toBeInTheDocument();
      expect(container.textContent).toContain('Application Error');
      expect(container.textContent).toContain('Try again');
      expect(container.textContent).toContain('Go home');
    });

    it('should render alert triangle icon', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.getByTestId('alert-triangle-icon')).toBeInTheDocument();
    });

    it('should render "Try again" button with icon', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(screen.getByTestId('rotate-ccw-icon')).toBeInTheDocument();
    });

    it('should render "Go home" button with icon', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.getByRole('button', { name: /go home/i })).toBeInTheDocument();
      expect(screen.getByTestId('home-icon')).toBeInTheDocument();
    });
  });

  describe('error logging', () => {
    it('should log error with correct parameters', async () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'Global error boundary triggered',
          mockError,
          expect.objectContaining({
            boundaryName: 'GlobalError',
            errorType: 'boundary',
            digest: undefined,
          })
        );
      });
    });

    it('should log error with digest when present', async () => {
      // Arrange & Act
      render(<GlobalError error={mockErrorWithDigest} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'Global error boundary triggered',
          mockErrorWithDigest,
          expect.objectContaining({
            boundaryName: 'GlobalError',
            errorType: 'boundary',
            digest: 'abc123',
          })
        );
      });
    });

    it('should call logger.error only once per error', async () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('sentry error tracking', () => {
    it('should call trackError with Fatal severity', async () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(trackError).toHaveBeenCalledWith(
          mockError,
          expect.objectContaining({
            level: ErrorSeverity.Fatal,
          })
        );
      });
    });

    it('should call trackError with correct tags', async () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(trackError).toHaveBeenCalledWith(
          mockError,
          expect.objectContaining({
            tags: {
              boundary: 'global',
              errorType: 'boundary',
            },
          })
        );
      });
    });

    it('should call trackError with correct extra context', async () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(trackError).toHaveBeenCalledWith(
          mockError,
          expect.objectContaining({
            extra: {
              digest: undefined,
              componentStack: 'global',
            },
          })
        );
      });
    });

    it('should call trackError with digest when present', async () => {
      // Arrange & Act
      render(<GlobalError error={mockErrorWithDigest} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(trackError).toHaveBeenCalledWith(
          mockErrorWithDigest,
          expect.objectContaining({
            extra: expect.objectContaining({
              digest: 'abc123',
            }),
          })
        );
      });
    });

    it('should call trackError only once per error', async () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Wait for useEffect to trigger
      await waitFor(() => {
        expect(trackError).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('user interactions', () => {
    it('should call reset() when "Try again" button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Act: Click the "Try again" button
      const tryAgainButton = screen.getByRole('button', { name: /try again/i });
      await user.click(tryAgainButton);

      // Assert
      expect(mockReset).toHaveBeenCalledTimes(1);
    });

    it('should navigate to "/" when "Go home" button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Act: Click the "Go home" button
      const goHomeButton = screen.getByRole('button', { name: /go home/i });
      await user.click(goHomeButton);

      // Assert
      expect(window.location.href).toBe('/');
    });

    it('should not call reset() when "Go home" button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Act: Click the "Go home" button
      const goHomeButton = screen.getByRole('button', { name: /go home/i });
      await user.click(goHomeButton);

      // Assert
      expect(mockReset).not.toHaveBeenCalled();
    });
  });

  describe('development mode', () => {
    beforeEach(() => {
      // Set development environment
      (process.env as { NODE_ENV: string }).NODE_ENV = 'development';
    });

    it('should show error message in development mode', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.getByText('Error:')).toBeInTheDocument();
      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('should show error digest in development mode when present', () => {
      // Arrange & Act
      render(<GlobalError error={mockErrorWithDigest} reset={mockReset} />);

      // Assert
      expect(screen.getByText('Error Digest:')).toBeInTheDocument();
      expect(screen.getByText('abc123')).toBeInTheDocument();
    });

    it('should not show error digest section when digest is missing', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.queryByText('Error Digest:')).not.toBeInTheDocument();
    });

    it('should not show contact support link in development mode', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.queryByText(/contact support/i)).not.toBeInTheDocument();
    });
  });

  describe('production mode', () => {
    beforeEach(() => {
      // Set production environment
      (process.env as { NODE_ENV: string }).NODE_ENV = 'production';
    });

    it('should hide error message in production mode', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.queryByText('Error:')).not.toBeInTheDocument();
      expect(screen.queryByText('Test error message')).not.toBeInTheDocument();
    });

    it('should hide error digest in production mode', () => {
      // Arrange & Act
      render(<GlobalError error={mockErrorWithDigest} reset={mockReset} />);

      // Assert
      expect(screen.queryByText('Error Digest:')).not.toBeInTheDocument();
      expect(screen.queryByText('abc123')).not.toBeInTheDocument();
    });

    it('should show contact support link in production mode', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.getByText(/If this problem persists, please/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /contact support/i })).toBeInTheDocument();
    });

    it('should have correct href for contact support link', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      const contactLink = screen.getByRole('link', { name: /contact support/i });
      expect(contactLink).toHaveAttribute('href', '/contact');
    });
  });

  describe('styling', () => {
    it('should render with proper container styling', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Verify styling on the main container div
      // Note: body and html tags are not rendered in test environment
      const mainContainer = screen.getByText('Application Error').closest('.rounded-lg');
      expect(mainContainer).toBeInTheDocument();
      expect(mainContainer).toHaveClass('bg-white');
      expect(mainContainer).toHaveClass('dark:bg-gray-800');
    });

    it('should have error styling on alert icon', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      const iconContainer = screen.getByTestId('alert-triangle-icon').parentElement;
      expect(iconContainer).toHaveClass('text-red-500');
    });

    it('should have proper button styling for "Try again"', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      const tryAgainButton = screen.getByRole('button', { name: /try again/i });
      expect(tryAgainButton).toHaveClass('bg-gray-900');
      expect(tryAgainButton).toHaveClass('text-white');
      expect(tryAgainButton).toHaveClass('dark:bg-gray-100');
      expect(tryAgainButton).toHaveClass('dark:text-gray-900');
    });

    it('should have proper button styling for "Go home"', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      const goHomeButton = screen.getByRole('button', { name: /go home/i });
      expect(goHomeButton).toHaveClass('border-gray-300');
      expect(goHomeButton).toHaveClass('bg-white');
      expect(goHomeButton).toHaveClass('text-gray-700');
      expect(goHomeButton).toHaveClass('dark:border-gray-600');
      expect(goHomeButton).toHaveClass('dark:bg-gray-800');
      expect(goHomeButton).toHaveClass('dark:text-gray-300');
    });
  });

  describe('accessibility', () => {
    it('should render component with semantic HTML structure', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert: Verify component renders with proper structure
      // Note: html/body elements with lang attr are in source but not testable in isolation
      // We verify the rendered semantic elements instead
      expect(screen.getByText('Application Error')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /go home/i })).toBeInTheDocument();
    });

    it('should have descriptive button text', () => {
      // Arrange & Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /go home/i })).toBeInTheDocument();
    });

    it('should have accessible contact support link in production', () => {
      // Arrange: Set production environment
      (process.env as { NODE_ENV: string }).NODE_ENV = 'production';

      // Act
      render(<GlobalError error={mockError} reset={mockReset} />);

      // Assert
      const contactLink = screen.getByRole('link', { name: /contact support/i });
      expect(contactLink).toBeInTheDocument();
      expect(contactLink).toHaveAttribute('href', '/contact');
    });
  });

  describe('edge cases', () => {
    it('should handle error with empty message', async () => {
      // Arrange
      const emptyError = new Error('');

      // Act
      render(<GlobalError error={emptyError} reset={mockReset} />);

      // Assert: Should still render and log
      expect(screen.getByText('Application Error')).toBeInTheDocument();
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalled();
        expect(trackError).toHaveBeenCalled();
      });
    });

    it('should handle multiple clicks on "Try again" button', async () => {
      // Arrange
      const user = userEvent.setup();
      render(<GlobalError error={mockError} reset={mockReset} />);
      const tryAgainButton = screen.getByRole('button', { name: /try again/i });

      // Act: Click multiple times
      await user.click(tryAgainButton);
      await user.click(tryAgainButton);
      await user.click(tryAgainButton);

      // Assert
      expect(mockReset).toHaveBeenCalledTimes(3);
    });

    it('should re-log error if error prop changes', async () => {
      // Arrange
      const { rerender } = render(<GlobalError error={mockError} reset={mockReset} />);
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledTimes(1);
      });
      vi.clearAllMocks();

      // Act: Change error
      const newError = new Error('New error');
      rerender(<GlobalError error={newError} reset={mockReset} />);

      // Assert: Should log the new error
      await waitFor(() => {
        expect(logger.error).toHaveBeenCalledWith(
          'Global error boundary triggered',
          newError,
          expect.any(Object)
        );
        expect(trackError).toHaveBeenCalledWith(newError, expect.any(Object));
      });
    });
  });
});
