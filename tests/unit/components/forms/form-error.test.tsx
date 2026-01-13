/**
 * FormError Component Tests
 *
 * Tests the form error message display component.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/form-error.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormError } from '@/components/forms/form-error';

// Mock error messages
vi.mock('@/lib/errors/messages', () => ({
  getUserFriendlyMessage: vi.fn((code?: string) => {
    const messages: Record<string, string> = {
      UNAUTHORIZED: 'Please sign in to continue.',
      FORBIDDEN: "You don't have permission to access this resource.",
      NOT_FOUND: 'The requested resource could not be found.',
      VALIDATION_ERROR: 'Please check your input and try again.',
      EMAIL_TAKEN: 'This email address is already registered.',
    };
    return code && code in messages ? messages[code] : 'An error occurred. Please try again.';
  }),
}));

/**
 * Test Suite: FormError Component
 */
describe('components/forms/form-error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should not render when no message and no code', () => {
      // Arrange & Act
      const { container } = render(<FormError />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should not render when message is undefined', () => {
      // Arrange & Act
      const { container } = render(<FormError message={undefined} />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should render with direct message', () => {
      // Arrange & Act
      render(<FormError message="This is an error" />);

      // Assert
      expect(screen.getByText('This is an error')).toBeInTheDocument();
    });

    it('should render with error code mapped to message', () => {
      // Arrange & Act
      render(<FormError code="UNAUTHORIZED" />);

      // Assert
      expect(screen.getByText('Please sign in to continue.')).toBeInTheDocument();
    });

    it('should render alert icon', () => {
      // Arrange & Act
      const { container } = render(<FormError message="Error" />);

      // Assert
      const icon = container.querySelector('svg');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('message priority', () => {
    it('should prioritize message prop over code prop', () => {
      // Arrange & Act
      render(<FormError message="Custom error" code="UNAUTHORIZED" />);

      // Assert
      expect(screen.getByText('Custom error')).toBeInTheDocument();
      expect(screen.queryByText('Please sign in to continue.')).not.toBeInTheDocument();
    });

    it('should use code when message is not provided', () => {
      // Arrange & Act
      render(<FormError code="VALIDATION_ERROR" />);

      // Assert
      expect(screen.getByText('Please check your input and try again.')).toBeInTheDocument();
    });
  });

  describe('error code mapping', () => {
    it('should map UNAUTHORIZED code', () => {
      // Arrange & Act
      render(<FormError code="UNAUTHORIZED" />);

      // Assert
      expect(screen.getByText('Please sign in to continue.')).toBeInTheDocument();
    });

    it('should map FORBIDDEN code', () => {
      // Arrange & Act
      render(<FormError code="FORBIDDEN" />);

      // Assert
      expect(
        screen.getByText("You don't have permission to access this resource.")
      ).toBeInTheDocument();
    });

    it('should map NOT_FOUND code', () => {
      // Arrange & Act
      render(<FormError code="NOT_FOUND" />);

      // Assert
      expect(screen.getByText('The requested resource could not be found.')).toBeInTheDocument();
    });

    it('should map EMAIL_TAKEN code', () => {
      // Arrange & Act
      render(<FormError code="EMAIL_TAKEN" />);

      // Assert
      expect(screen.getByText('This email address is already registered.')).toBeInTheDocument();
    });

    it('should show generic message for unknown code', () => {
      // Arrange & Act
      render(<FormError code="UNKNOWN_CODE" />);

      // Assert
      expect(screen.getByText('An error occurred. Please try again.')).toBeInTheDocument();
    });
  });

  describe('styling', () => {
    it('should have error styling classes', () => {
      // Arrange & Act
      const { container } = render(<FormError message="Error" />);

      // Assert
      const errorDiv = container.firstChild as HTMLElement;
      expect(errorDiv).toHaveClass('border-red-300');
      expect(errorDiv).toHaveClass('bg-red-50');
      expect(errorDiv).toHaveClass('text-red-700');
    });

    it('should have dark mode classes', () => {
      // Arrange & Act
      const { container } = render(<FormError message="Error" />);

      // Assert
      const errorDiv = container.firstChild as HTMLElement;
      expect(errorDiv).toHaveClass('dark:border-red-800');
      expect(errorDiv).toHaveClass('dark:bg-red-950/50');
      expect(errorDiv).toHaveClass('dark:text-red-400');
    });

    it('should have flex layout', () => {
      // Arrange & Act
      const { container } = render(<FormError message="Error" />);

      // Assert
      const errorDiv = container.firstChild as HTMLElement;
      expect(errorDiv).toHaveClass('flex');
      expect(errorDiv).toHaveClass('items-center');
      expect(errorDiv).toHaveClass('gap-2');
    });
  });

  describe('accessibility', () => {
    it('should have readable text', () => {
      // Arrange & Act
      render(<FormError message="Invalid email format" />);

      // Assert
      expect(screen.getByText('Invalid email format')).toBeInTheDocument();
    });
  });
});
