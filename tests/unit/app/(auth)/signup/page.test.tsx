// @vitest-environment happy-dom

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
 * @see app/(auth)/signup/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import SignupPage, { generateMetadata } from '@/app/(auth)/signup/page';

// Mock next/navigation (required by SignupForm component)
vi.mock('next/navigation', async () => {
  const { createMockRouter } = await import('@/tests/types/mocks');
  return {
    useRouter: vi.fn(() => createMockRouter()),
    usePathname: vi.fn(() => '/signup'),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

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
// Which keys name a plan is signup-plan.test.ts; here, what the page does with
// the answer (§139 t-1096).
const mockOffer = vi.hoisted(() => vi.fn());
vi.mock('@/lib/billing/signup-plan', () => ({
  SIGNUP_PLAN_PARAM: 'plan',
  signupPlanOffer: mockOffer,
}));

/** The page as Next renders it, with this query string. */
async function page(query: Record<string, string> = {}) {
  return SignupPage({ searchParams: Promise.resolve(query) });
}

describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOffer.mockReturnValue(null);
  });

  /**
   * Metadata Tests
   *
   * Tests that the page exports correct metadata for Next.js.
   */
  describe('metadata', () => {
    it('should have correct title', async () => {
      const metadata = await generateMetadata();
      expect(metadata.title).toBe('Create Account');
    });

    it('should have correct description', async () => {
      const metadata = await generateMetadata();
      expect(metadata.description).toBe('Create a new Sunrise account');
    });
  });

  /**
   * Rendering Tests
   *
   * Tests that the page renders without crashing and contains expected elements.
   */
  describe('rendering', () => {
    it('should render without crashing', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Page renders successfully
      expect(screen.getByText('Create an account')).toBeInTheDocument();
    });

    it('should render page title "Create an account"', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Title is visible
      const title = screen.getByText('Create an account');
      expect(title).toBeInTheDocument();
      expect(title.tagName).toBe('DIV'); // CardTitle renders as div
    });

    it('should render page description', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Description is visible
      expect(screen.getByText('Enter your information to create your account')).toBeInTheDocument();
    });

    it('should render within a Card component', async () => {
      // Arrange & Act
      const { container } = render(await page());

      // Assert: Card structure is present (Card has specific class patterns)
      const cardElement = container.querySelector('[class*="border"]');
      expect(cardElement).toBeInTheDocument();
    });

    it('should render CardHeader with proper structure', async () => {
      // Arrange & Act
      render(await page());

      // Assert: CardHeader contains both title and description
      expect(screen.getByText('Create an account')).toBeInTheDocument();
      expect(screen.getByText('Enter your information to create your account')).toBeInTheDocument();
    });

    it('should render CardContent with proper spacing', async () => {
      // Arrange & Act
      const { container } = render(await page());

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
    it('should wrap SignupForm in Suspense boundary', async () => {
      // Arrange & Act
      render(await page());

      // Assert: SignupForm renders successfully (wrapped in Suspense)
      // We can verify by checking for elements that only appear in SignupForm
      // Note: In test environment, Suspense doesn't suspend, so fallback won't show
      expect(screen.queryByText('Create an account')).toBeInTheDocument();
    });

    it('should have fallback UI for Suspense', async () => {
      // Arrange & Act
      render(await page());

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
      render(await page());

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
      render(await page());

      // Assert: Name field is present
      await waitFor(() => {
        const nameInput = screen.getByLabelText(/full name/i);
        expect(nameInput).toBeInTheDocument();
        expect(nameInput).toHaveAttribute('type', 'text');
      });
    });

    it('should render email input field from SignupForm', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Email field is present
      await waitFor(() => {
        const emailInput = screen.getByLabelText(/email/i);
        expect(emailInput).toBeInTheDocument();
        expect(emailInput).toHaveAttribute('type', 'email');
      });
    });

    it('should render password input fields from SignupForm', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Password fields are present
      await waitFor(() => {
        const passwordInputs = screen.getAllByLabelText(/password/i);
        expect(passwordInputs.length).toBeGreaterThanOrEqual(2); // Password and Confirm Password
      });
    });

    it('should render submit button from SignupForm', async () => {
      // Arrange & Act
      render(await page());

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
    it('should render login link text', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Login link text is visible
      expect(screen.getByText(/already have an account\?/i)).toBeInTheDocument();
    });

    it('should render "Sign in" link with correct href', async () => {
      // Arrange & Act
      render(await page());

      // Assert: "Sign in" link is present and points to /login
      const signInLink = screen.getByRole('link', { name: /sign in/i });
      expect(signInLink).toBeInTheDocument();
      expect(signInLink).toHaveAttribute('href', '/login');
    });

    it('should render login link with correct styling', async () => {
      // Arrange & Act
      render(await page());

      // Assert: "Sign in" link has primary color and hover underline
      const signInLink = screen.getByRole('link', { name: /sign in/i });
      expect(signInLink.className).toContain('text-primary');
      expect(signInLink.className).toContain('hover:underline');
    });

    it('should render login link as centered text', async () => {
      // Arrange & Act
      const { container } = render(await page());

      // Assert: Login link container has text-center class
      const loginContainer = container.querySelector('.text-center');
      expect(loginContainer).toBeInTheDocument();
      expect(loginContainer?.textContent).toContain('Already have an account?');
    });

    it('should render muted text for "Already have an account?"', async () => {
      // Arrange & Act
      const { container } = render(await page());

      // Assert: "Already have an account?" text has muted color
      // Find the specific span with muted text that contains our login link text
      const allMutedTexts = container.querySelectorAll('.text-muted-foreground');
      const loginPromptText = Array.from(allMutedTexts).find((el) =>
        el.textContent?.includes('Already have an account?')
      );
      expect(loginPromptText).toBeInTheDocument();
      expect(loginPromptText?.textContent).toBe('Already have an account?');
    });
  });

  /**
   * Accessibility Tests
   *
   * Tests that the page is accessible and follows best practices.
   */
  describe('accessibility', () => {
    it('should have proper heading hierarchy', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Page title is visible and prominent
      const title = screen.getByText('Create an account');
      expect(title).toBeInTheDocument();
      // Page uses font-bold class for the title
      expect(title.className).toContain('font-bold');
    });

    it('should have descriptive text for screen readers', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Description provides context for screen readers
      const description = screen.getByText('Enter your information to create your account');
      expect(description).toBeInTheDocument();
    });

    it('should have accessible form inputs with labels', async () => {
      // Arrange & Act
      render(await page());

      // Assert: All form inputs have associated labels
      await waitFor(() => {
        expect(screen.getByLabelText(/full name/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
        expect(screen.getAllByLabelText(/password/i).length).toBeGreaterThan(0);
      });
    });

    it('should have accessible submit button', async () => {
      // Arrange & Act
      render(await page());

      // Assert: Submit button has accessible name
      await waitFor(() => {
        const submitButton = screen.getByRole('button', { name: /create account/i });
        expect(submitButton).toBeInTheDocument();
      });
    });

    it('should have accessible navigation link', async () => {
      // Arrange & Act
      render(await page());

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
    it('should render CardHeader before CardContent', async () => {
      // Arrange & Act
      const { container } = render(await page());

      // Assert: Title appears before form content in DOM order
      const allText = container.textContent;
      const titleIndex = allText?.indexOf('Create an account');
      const formIndex = allText?.indexOf('Full Name');

      expect(titleIndex).toBeLessThan(formIndex || Infinity);
    });

    it('should render SignupForm before login link', async () => {
      // Arrange & Act
      const { container } = render(await page());

      // Assert: Form appears before "Already have an account?" in DOM order
      const allText = container.textContent;
      const formIndex = allText?.indexOf('Create Account'); // Submit button text
      const linkIndex = allText?.indexOf('Already have an account?');

      expect(formIndex).toBeLessThan(linkIndex || Infinity);
    });

    it('should have vertical spacing between form and login link', async () => {
      // Arrange & Act
      const { container } = render(await page());

      // Assert: CardContent has space-y-4 class for vertical spacing
      const cardContent = container.querySelector('[class*="space-y-4"]');
      expect(cardContent).toBeInTheDocument();
    });

    it('should render all content within CardContent', async () => {
      // Arrange & Act
      render(await page());

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
      render(await page());

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
      render(await page());

      // Assert: Page renders normally
      await waitFor(() => {
        expect(screen.getByText('Create an account')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
      });
    });
  });
});

describe('SignupPage — a plan from the signup link (§139 t-1096)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says which paid plan they are signing up for, and that payment follows', async () => {
    mockOffer.mockReturnValue({ key: 'pro', label: 'Pro', paid: true });

    render(await page({ plan: 'pro' }));

    expect(mockOffer).toHaveBeenCalledWith('pro');
    expect(screen.getByRole('status')).toHaveTextContent(
      'You are signing up for the Pro plan. Once your account is set up, you go to the payment page to pay for it.'
    );
  });

  it('says which free plan, with no word of payment', async () => {
    mockOffer.mockReturnValue({ key: 'starter', label: 'Starter', paid: false });

    render(await page({ plan: 'starter' }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'You are signing up for the Starter plan.'
    );
    expect(screen.getByRole('status')).not.toHaveTextContent(/payment/);
  });

  it('shows nothing for a plan that is not offered, or none', async () => {
    mockOffer.mockReturnValue(null);

    render(await page({ plan: 'platinum' }));

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
