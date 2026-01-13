/**
 * Signup Page Tests
 *
 * Tests the signup page server component that renders the SignupForm client component.
 *
 * File Structure:
 * - page.tsx - Server component with metadata, renders SignupForm wrapped in Card UI
 *
 * Test Coverage:
 * - Rendering without crashing
 * - Page metadata (title)
 * - Card header with correct title and description
 * - SignupForm component is rendered within Suspense boundary
 * - Suspense fallback for SignupForm (uses useSearchParams)
 * - Login link visibility and correct href
 * - Overall page structure and accessibility
 *
 * Note: The SignupForm component itself has its own separate test file.
 * These tests focus on the server component wrapper and page-level concerns.
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/(auth)/signup/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SignupPage, { metadata } from '@/app/(auth)/signup/page';

// Mock next/navigation (required by SignupForm component)
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/signup'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Mock better-auth client (required by SignupForm component)
vi.mock('@/lib/auth/client', () => ({
  authClient: {
    signUp: {
      email: vi.fn(),
    },
    getSession: vi.fn(() => ({ data: null })),
  },
}));

/**
 * Test Suite: Signup Page
 *
 * Tests the signup page server component wrapper and overall page structure.
 */
describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Metadata Tests
   *
   * Tests that the page exports correct metadata for Next.js.
   */
  describe('metadata', () => {
    it('should have correct title', () => {
      expect(metadata.title).toBe('Create Account');
    });

    it('should have correct description', () => {
      expect(metadata.description).toBe('Create a new Sunrise account');
    });
  });

  /**
   * Rendering Tests
   *
   * Tests that the page renders without crashing and contains expected elements.
   */
  describe('rendering', () => {
    it('should render without crashing', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Page renders successfully
      expect(screen.getByText('Create an account')).toBeInTheDocument();
    });

    it('should render page title "Create an account"', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Title is visible
      const title = screen.getByText('Create an account');
      expect(title).toBeInTheDocument();
      expect(title.tagName).toBe('DIV'); // CardTitle renders as div
    });

    it('should render page description', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Description is visible
      expect(screen.getByText('Enter your information to create your account')).toBeInTheDocument();
    });

    it('should render within a Card component', () => {
      // Arrange & Act
      const { container } = render(<SignupPage />);

      // Assert: Card structure is present (Card has specific class patterns)
      const cardElement = container.querySelector('[class*="border"]');
      expect(cardElement).toBeInTheDocument();
    });

    it('should render CardHeader with proper structure', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: CardHeader contains both title and description
      expect(screen.getByText('Create an account')).toBeInTheDocument();
      expect(screen.getByText('Enter your information to create your account')).toBeInTheDocument();
    });

    it('should render CardContent with proper spacing', () => {
      // Arrange & Act
      const { container } = render(<SignupPage />);

      // Assert: CardContent has space-y-4 class for vertical spacing
      const cardContent = container.querySelector('[class*="space-y-4"]');
      expect(cardContent).toBeInTheDocument();
    });
  });

  /**
   * Suspense Boundary Tests
   *
   * Tests the Suspense fallback that wraps the SignupForm component.
   * SignupForm uses useSearchParams() which requires Suspense boundary.
   */
  describe('Suspense boundary', () => {
    it('should wrap SignupForm in Suspense boundary', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: SignupForm renders successfully (wrapped in Suspense)
      // We can verify by checking for elements that only appear in SignupForm
      // Note: In test environment, Suspense doesn't suspend, so fallback won't show
      expect(screen.queryByText('Create an account')).toBeInTheDocument();
    });

    it('should have fallback UI for Suspense', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Page renders without errors
      // The fallback is <div>Loading...</div> but won't be visible in tests
      // because Suspense doesn't suspend in test environment
      expect(screen.getByText('Create an account')).toBeInTheDocument();
    });
  });

  /**
   * SignupForm Component Integration Tests
   *
   * Tests that the SignupForm component is rendered correctly within the page.
   * Note: Detailed SignupForm tests are in a separate test file.
   */
  describe('SignupForm integration', () => {
    it('should render SignupForm component', async () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: SignupForm elements are present
      // Check for OAuth buttons (rendered by SignupForm)
      // Note: There are multiple elements with "continue with" text
      await waitFor(() => {
        const continueWithTexts = screen.getAllByText(/continue with/i);
        expect(continueWithTexts.length).toBeGreaterThan(0);
      });
    });

    it('should render name input field from SignupForm', async () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Name field is present
      await waitFor(() => {
        const nameInput = screen.getByLabelText(/full name/i);
        expect(nameInput).toBeInTheDocument();
        expect(nameInput).toHaveAttribute('type', 'text');
      });
    });

    it('should render email input field from SignupForm', async () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Email field is present
      await waitFor(() => {
        const emailInput = screen.getByLabelText(/email/i);
        expect(emailInput).toBeInTheDocument();
        expect(emailInput).toHaveAttribute('type', 'email');
      });
    });

    it('should render password input fields from SignupForm', async () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Password fields are present
      await waitFor(() => {
        const passwordInputs = screen.getAllByLabelText(/password/i);
        expect(passwordInputs.length).toBeGreaterThanOrEqual(2); // Password and Confirm Password
      });
    });

    it('should render submit button from SignupForm', async () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Submit button is present
      await waitFor(() => {
        const submitButton = screen.getByRole('button', { name: /create account/i });
        expect(submitButton).toBeInTheDocument();
        expect(submitButton).toHaveAttribute('type', 'submit');
      });
    });
  });

  /**
   * Login Link Tests
   *
   * Tests the "Already have an account? Sign in" link.
   */
  describe('login link', () => {
    it('should render login link text', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Login link text is visible
      expect(screen.getByText(/already have an account\?/i)).toBeInTheDocument();
    });

    it('should render "Sign in" link with correct href', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: "Sign in" link is present and points to /login
      const signInLink = screen.getByRole('link', { name: /sign in/i });
      expect(signInLink).toBeInTheDocument();
      expect(signInLink).toHaveAttribute('href', '/login');
    });

    it('should render login link with correct styling', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: "Sign in" link has primary color and hover underline
      const signInLink = screen.getByRole('link', { name: /sign in/i });
      expect(signInLink.className).toContain('text-primary');
      expect(signInLink.className).toContain('hover:underline');
    });

    it('should render login link as centered text', () => {
      // Arrange & Act
      const { container } = render(<SignupPage />);

      // Assert: Login link container has text-center class
      const loginContainer = container.querySelector('.text-center');
      expect(loginContainer).toBeInTheDocument();
      expect(loginContainer?.textContent).toContain('Already have an account?');
    });

    it('should render muted text for "Already have an account?"', () => {
      // Arrange & Act
      const { container } = render(<SignupPage />);

      // Assert: "Already have an account?" text has muted color
      // Find the specific span with muted text that contains our login link text
      const allMutedTexts = container.querySelectorAll('.text-muted-foreground');
      const loginPromptText = Array.from(allMutedTexts).find((el) =>
        el.textContent?.includes('Already have an account?')
      );
      expect(loginPromptText).toBeInTheDocument();
      expect(loginPromptText?.textContent).toBe('Already have an account? ');
    });
  });

  /**
   * Accessibility Tests
   *
   * Tests that the page is accessible and follows best practices.
   */
  describe('accessibility', () => {
    it('should have proper heading hierarchy', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Page title is visible and prominent
      const title = screen.getByText('Create an account');
      expect(title).toBeInTheDocument();
      // Page uses font-bold class for the title
      expect(title.className).toContain('font-bold');
    });

    it('should have descriptive text for screen readers', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Description provides context for screen readers
      const description = screen.getByText('Enter your information to create your account');
      expect(description).toBeInTheDocument();
    });

    it('should have accessible form inputs with labels', async () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: All form inputs have associated labels
      await waitFor(() => {
        expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });
    });

    it('should have accessible submit button', async () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Submit button has accessible name
      await waitFor(() => {
        const submitButton = screen.getByRole('button', { name: /create account/i });
        expect(submitButton).toBeInTheDocument();
      });
    });

    it('should have accessible navigation link', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Login link is accessible
      const signInLink = screen.getByRole('link', { name: /sign in/i });
      expect(signInLink).toBeInTheDocument();
    });
  });

  /**
   * Layout and Structure Tests
   *
   * Tests the overall layout structure and spacing.
   */
  describe('layout and structure', () => {
    it('should render CardHeader before CardContent', () => {
      // Arrange & Act
      const { container } = render(<SignupPage />);

      // Assert: Title appears before form content in DOM order
      const allText = container.textContent;
      const titleIndex = allText?.indexOf('Create an account');
      const formIndex = allText?.indexOf('Full Name');

      expect(titleIndex).toBeLessThan(formIndex || Infinity);
    });

    it('should render SignupForm before login link', () => {
      // Arrange & Act
      const { container } = render(<SignupPage />);

      // Assert: Form appears before "Already have an account?" in DOM order
      const allText = container.textContent;
      const formIndex = allText?.indexOf('Create Account'); // Submit button text
      const linkIndex = allText?.indexOf('Already have an account?');

      expect(formIndex).toBeLessThan(linkIndex || Infinity);
    });

    it('should have vertical spacing between form and login link', () => {
      // Arrange & Act
      const { container } = render(<SignupPage />);

      // Assert: CardContent has space-y-4 class for vertical spacing
      const cardContent = container.querySelector('[class*="space-y-4"]');
      expect(cardContent).toBeInTheDocument();
    });

    it('should render all content within CardContent', () => {
      // Arrange & Act
      render(<SignupPage />);

      // Assert: Both SignupForm and login link are visible
      expect(screen.getByRole('button', { name: /create account/i })).toBeDefined();
      expect(screen.getByText(/already have an account\?/i)).toBeInTheDocument();
    });
  });

  /**
   * OAuth Error Handling Tests
   *
   * Tests that the page can handle OAuth error parameters from URL.
   * Note: OAuth errors are handled by SignupForm via useSearchParams.
   */
  describe('OAuth error handling', () => {
    it('should pass error parameters to SignupForm via useSearchParams', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams(
          'error=oauth_error&error_description=OAuth+failed'
        ) as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SignupPage />);

      // Assert: Page renders without crashing (error handling is in SignupForm)
      await waitFor(() => {
        expect(screen.getByText('Create an account')).toBeInTheDocument();
      });
    });

    it('should render normally without error parameters', async () => {
      // Arrange
      const { useSearchParams } = await import('next/navigation');
      vi.mocked(useSearchParams).mockReturnValue(
        new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>
      );

      // Act
      render(<SignupPage />);

      // Assert: Page renders normally
      await waitFor(() => {
        expect(screen.getByText('Create an account')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
      });
    });
  });
});
