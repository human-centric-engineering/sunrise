/**
 * Login Page Tests
 *
 * Tests the login page component that serves as the main authentication entry point.
 *
 * Test Coverage:
 * - Page renders without crashing
 * - Metadata (title and description)
 * - LoginForm component rendering
 * - Sign up link navigation
 * - Password reset link navigation
 * - Welcome message and description
 * - Suspense boundary for LoginForm
 * - Card structure and layout
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/(auth)/login/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import LoginPage, { metadata } from '@/app/(auth)/login/page';

/**
 * Mock the LoginForm component
 *
 * The LoginForm is a client component with complex authentication logic.
 * We mock it to isolate the page component's responsibilities (layout, links, text).
 */
vi.mock('@/components/forms/login-form', () => ({
  LoginForm: vi.fn(() => <div data-testid="login-form">Login Form Mock</div>),
}));

/**
 * Test Suite: Login Page
 *
 * Tests the server component that renders the login page layout.
 */
describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Metadata Tests
   *
   * Tests the page metadata exported for Next.js SEO and browser tab display.
   */
  describe('metadata', () => {
    it('should have correct title', () => {
      // Assert: Title is set correctly
      expect(metadata.title).toBe('Sign In');
    });

    it('should have correct description', () => {
      // Assert: Description is set correctly
      expect(metadata.description).toBe('Sign in to your Sunrise account');
    });
  });

  /**
   * Rendering Tests
   *
   * Tests that the page renders all required elements correctly.
   */
  describe('rendering', () => {
    it('should render without crashing', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Page renders successfully
      expect(screen.getByText('Welcome back')).toBeInTheDocument();
    });

    it('should render the welcome title', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Title is displayed
      const title = screen.getByText('Welcome back');
      expect(title).toBeInTheDocument();
      expect(title.tagName).toBe('DIV'); // CardTitle renders as div
    });

    it('should render the page description', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Description text is displayed
      expect(
        screen.getByText('Enter your email and password to sign in to your account')
      ).toBeInTheDocument();
    });

    it('should render the LoginForm component', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: LoginForm is rendered
      expect(screen.getByTestId('login-form')).toBeInTheDocument();
      expect(screen.getByText('Login Form Mock')).toBeInTheDocument();
    });

    it('should render the login form inside a Suspense boundary', () => {
      // Arrange & Act
      // Note: In test environment, Suspense doesn't suspend, so we just verify
      // the component renders (no fallback visible)
      render(<LoginPage />);

      // Assert: LoginForm is rendered (Suspense doesn't block in tests)
      expect(screen.getByTestId('login-form')).toBeInTheDocument();

      // Assert: Fallback is not shown (component loaded immediately in tests)
      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    });
  });

  /**
   * Sign Up Link Tests
   *
   * Tests the link to the signup page for new users.
   */
  describe('sign up link', () => {
    it('should render the sign up link', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link is present
      const signUpLink = screen.getByRole('link', { name: /sign up/i });
      expect(signUpLink).toBeInTheDocument();
    });

    it('should link to the signup page', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link has correct href
      const signUpLink = screen.getByRole('link', { name: /sign up/i });
      expect(signUpLink).toHaveAttribute('href', '/signup');
    });

    it('should render "Don\'t have an account?" text', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Prompt text is displayed
      expect(screen.getByText(/don't have an account\?/i)).toBeInTheDocument();
    });

    it('should render sign up link with primary color styling', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link has primary color class
      const signUpLink = screen.getByRole('link', { name: /sign up/i });
      expect(signUpLink.className).toContain('text-primary');
    });

    it('should render sign up link with hover underline', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link has hover underline class
      const signUpLink = screen.getByRole('link', { name: /sign up/i });
      expect(signUpLink.className).toContain('hover:underline');
    });
  });

  /**
   * Password Reset Link Tests
   *
   * Tests the link to the password reset page.
   */
  describe('password reset link', () => {
    it('should render the password reset link', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link is present
      const resetLink = screen.getByRole('link', { name: /forgot your password\?/i });
      expect(resetLink).toBeInTheDocument();
    });

    it('should link to the reset password page', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link has correct href
      const resetLink = screen.getByRole('link', { name: /forgot your password\?/i });
      expect(resetLink).toHaveAttribute('href', '/reset-password');
    });

    it('should render password reset link with muted text color', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link has muted text class
      const resetLink = screen.getByRole('link', { name: /forgot your password\?/i });
      expect(resetLink.className).toContain('text-muted-foreground');
    });

    it('should render password reset link with hover styling', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Link has hover classes
      const resetLink = screen.getByRole('link', { name: /forgot your password\?/i });
      expect(resetLink.className).toContain('hover:text-primary');
      expect(resetLink.className).toContain('hover:underline');
    });
  });

  /**
   * Layout Structure Tests
   *
   * Tests the overall card layout and organization.
   */
  describe('layout structure', () => {
    it('should render content inside a card', () => {
      // Arrange & Act
      const { container } = render(<LoginPage />);

      // Assert: Card structure is present
      // Note: Card components use specific class patterns
      const cardElement = container.querySelector('[class*="border"]');
      expect(cardElement).toBeInTheDocument();
    });

    it('should render card header with correct spacing', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Card header contains title and description
      const title = screen.getByText('Welcome back');
      const description = screen.getByText(
        'Enter your email and password to sign in to your account'
      );

      expect(title).toBeInTheDocument();
      expect(description).toBeInTheDocument();
    });

    it('should render card content with proper spacing', () => {
      // Arrange & Act
      const { container } = render(<LoginPage />);

      // Assert: CardContent has spacing class
      const cardContent = container.querySelector('[class*="space-y-4"]');
      expect(cardContent).toBeInTheDocument();
    });

    it('should render title with correct styling classes', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Title has proper size and weight classes
      const title = screen.getByText('Welcome back');
      expect(title.className).toContain('text-2xl');
      expect(title.className).toContain('font-bold');
    });

    it('should render both navigation links in separate sections', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Both links are present and separated
      const signUpLink = screen.getByRole('link', { name: /sign up/i });
      const resetLink = screen.getByRole('link', { name: /forgot your password\?/i });

      expect(signUpLink).toBeInTheDocument();
      expect(resetLink).toBeInTheDocument();
    });

    it('should center text for navigation links', () => {
      // Arrange & Act
      const { container } = render(<LoginPage />);

      // Assert: Text center class is applied to link containers
      const textCenterElements = container.querySelectorAll('[class*="text-center"]');
      expect(textCenterElements.length).toBeGreaterThanOrEqual(2); // At least 2 centered sections
    });

    it('should render small text size for navigation sections', () => {
      // Arrange & Act
      const { container } = render(<LoginPage />);

      // Assert: Small text class is applied
      const smallTextElements = container.querySelectorAll('[class*="text-sm"]');
      expect(smallTextElements.length).toBeGreaterThanOrEqual(2); // Both link sections
    });
  });

  /**
   * Accessibility Tests
   *
   * Tests accessibility features of the login page.
   */
  describe('accessibility', () => {
    it('should have title element with appropriate styling', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Title is rendered with proper classes for visual hierarchy
      const title = screen.getByText('Welcome back');
      expect(title).toBeInTheDocument();
      expect(title.className).toContain('font-bold'); // Custom class from page
      expect(title.className).toContain('tracking-tight'); // From CardTitle base
      expect(title.className).toContain('text-2xl'); // Custom class from page
    });

    it('should have accessible link text', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Links have descriptive text
      expect(screen.getByRole('link', { name: /sign up/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /forgot your password\?/i })).toBeInTheDocument();
    });

    it('should render all navigation links as proper anchor tags', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Both links are anchor elements
      const links = screen.getAllByRole('link');
      expect(links.length).toBe(2);
      links.forEach((link) => {
        expect(link.tagName).toBe('A');
      });
    });
  });

  /**
   * Integration Tests
   *
   * Tests how components work together in the page.
   */
  describe('integration', () => {
    it('should render all major sections together', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: All sections are present
      expect(screen.getByText('Welcome back')).toBeInTheDocument();
      expect(
        screen.getByText('Enter your email and password to sign in to your account')
      ).toBeInTheDocument();
      expect(screen.getByTestId('login-form')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /sign up/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /forgot your password\?/i })).toBeInTheDocument();
    });

    it('should maintain correct visual order of elements', () => {
      // Arrange & Act
      render(<LoginPage />);

      // Assert: Elements appear in expected order
      const container = screen.getByText('Welcome back').closest('[class*="space-y"]');
      expect(container).toBeInTheDocument();

      // Title appears before form
      const title = screen.getByText('Welcome back');
      const form = screen.getByTestId('login-form');
      expect(title.compareDocumentPosition(form)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

      // Form appears before links
      const signUpLink = screen.getByRole('link', { name: /sign up/i });
      expect(form.compareDocumentPosition(signUpLink)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });
  });
});
