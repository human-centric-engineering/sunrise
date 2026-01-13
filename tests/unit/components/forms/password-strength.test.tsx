/**
 * PasswordStrength Component Tests
 *
 * Tests the password strength visual indicator component.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/forms/password-strength.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PasswordStrength } from '@/components/forms/password-strength';

// Mock password strength calculator
vi.mock('@/lib/utils/password-strength', () => ({
  calculatePasswordStrength: vi.fn((password: string) => {
    if (password.length === 0) {
      return { percentage: 0, label: 'Weak', color: 'bg-red-500' };
    }
    if (password === 'weak') {
      return { percentage: 25, label: 'Weak', color: 'bg-red-500' };
    }
    if (password === 'fair1234') {
      return { percentage: 50, label: 'Fair', color: 'bg-orange-500' };
    }
    if (password === 'Good1234') {
      return { percentage: 75, label: 'Good', color: 'bg-yellow-500' };
    }
    if (password === 'Strong1234!') {
      return { percentage: 100, label: 'Strong', color: 'bg-green-500' };
    }
    return { percentage: 50, label: 'Fair', color: 'bg-orange-500' };
  }),
}));

/**
 * Test Suite: PasswordStrength Component
 */
describe('components/forms/password-strength', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('should not render when password is empty', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="" />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should render progress bar for non-empty password', () => {
      // Arrange & Act
      render(<PasswordStrength password="test" />);

      // Assert
      expect(screen.getByText(/password strength/i)).toBeInTheDocument();
    });

    it('should render strength label', () => {
      // Arrange & Act
      render(<PasswordStrength password="fair1234" />);

      // Assert
      expect(screen.getByText('Fair')).toBeInTheDocument();
    });
  });

  describe('strength levels', () => {
    it('should display "Weak" for weak password', () => {
      // Arrange & Act
      render(<PasswordStrength password="weak" />);

      // Assert
      expect(screen.getByText('Weak')).toBeInTheDocument();
    });

    it('should display "Fair" for fair password', () => {
      // Arrange & Act
      render(<PasswordStrength password="fair1234" />);

      // Assert
      expect(screen.getByText('Fair')).toBeInTheDocument();
    });

    it('should display "Good" for good password', () => {
      // Arrange & Act
      render(<PasswordStrength password="Good1234" />);

      // Assert
      expect(screen.getByText('Good')).toBeInTheDocument();
    });

    it('should display "Strong" for strong password', () => {
      // Arrange & Act
      render(<PasswordStrength password="Strong1234!" />);

      // Assert
      expect(screen.getByText('Strong')).toBeInTheDocument();
    });
  });

  describe('progress bar', () => {
    it('should set correct width for weak password (25%)', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="weak" />);

      // Assert
      const progressBar = container.querySelector('[style*="width"]');
      expect(progressBar).toHaveStyle({ width: '25%' });
    });

    it('should set correct width for fair password (50%)', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="fair1234" />);

      // Assert
      const progressBar = container.querySelector('[style*="width"]');
      expect(progressBar).toHaveStyle({ width: '50%' });
    });

    it('should set correct width for good password (75%)', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="Good1234" />);

      // Assert
      const progressBar = container.querySelector('[style*="width"]');
      expect(progressBar).toHaveStyle({ width: '75%' });
    });

    it('should set correct width for strong password (100%)', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="Strong1234!" />);

      // Assert
      const progressBar = container.querySelector('[style*="width"]');
      expect(progressBar).toHaveStyle({ width: '100%' });
    });
  });

  describe('color classes', () => {
    it('should apply red color for weak password', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="weak" />);

      // Assert
      const progressBar = container.querySelector('.bg-red-500');
      expect(progressBar).toBeInTheDocument();
    });

    it('should apply orange color for fair password', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="fair1234" />);

      // Assert
      const progressBar = container.querySelector('.bg-orange-500');
      expect(progressBar).toBeInTheDocument();
    });

    it('should apply yellow color for good password', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="Good1234" />);

      // Assert
      const progressBar = container.querySelector('.bg-yellow-500');
      expect(progressBar).toBeInTheDocument();
    });

    it('should apply green color for strong password', () => {
      // Arrange & Act
      const { container } = render(<PasswordStrength password="Strong1234!" />);

      // Assert
      const progressBar = container.querySelector('.bg-green-500');
      expect(progressBar).toBeInTheDocument();
    });
  });

  describe('integration', () => {
    it('should call calculatePasswordStrength with password', async () => {
      // Arrange
      const { calculatePasswordStrength } = await import('@/lib/utils/password-strength');

      // Act
      render(<PasswordStrength password="test123" />);

      // Assert
      expect(calculatePasswordStrength).toHaveBeenCalledWith('test123');
    });

    it('should update when password prop changes', () => {
      // Arrange
      const { rerender } = render(<PasswordStrength password="weak" />);
      expect(screen.getByText('Weak')).toBeInTheDocument();

      // Act
      rerender(<PasswordStrength password="Strong1234!" />);

      // Assert
      expect(screen.getByText('Strong')).toBeInTheDocument();
    });
  });

  describe('accessibility', () => {
    it('should have descriptive text', () => {
      // Arrange & Act
      render(<PasswordStrength password="test" />);

      // Assert
      expect(screen.getByText(/password strength:/i)).toBeInTheDocument();
    });
  });
});
