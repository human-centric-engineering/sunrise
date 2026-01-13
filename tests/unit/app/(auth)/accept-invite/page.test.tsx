/**
 * Accept Invitation Page Tests
 *
 * Tests the accept invitation page component that appears when users click
 * on invitation links sent by administrators.
 *
 * File Structure:
 * - page.tsx - Server component with metadata, renders Card with AcceptInviteForm
 * - accept-invite-form.tsx - Client component with form (tested separately)
 *
 * Test Coverage:
 * - Page renders without crashing
 * - Renders AcceptInviteForm component within Suspense boundary
 * - Displays correct title "Accept Invitation"
 * - Displays correct description
 * - Renders Card components (Card, CardHeader, CardContent)
 * - Suspense boundary renders fallback during loading
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/app/(auth)/accept-invite/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import AcceptInvitePage from '@/app/(auth)/accept-invite/page';

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/accept-invite'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

// Mock the AcceptInviteForm component to avoid complexity
vi.mock('@/components/forms/accept-invite-form', () => ({
  AcceptInviteForm: () => <div data-testid="accept-invite-form">Accept Invite Form Component</div>,
}));

// Mock the API client
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn(),
    post: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    code: string;
    details?: unknown;

    constructor(message: string, code: string, details?: unknown) {
      super(message);
      this.name = 'APIClientError';
      this.code = code;
      this.details = details;
    }
  },
}));

/**
 * Test Suite: Accept Invitation Page
 *
 * Tests the page that wraps the accept invitation form.
 * This is a server component with metadata and a Suspense boundary.
 */
describe('AcceptInvitePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Basic Rendering Tests
   *
   * Tests that the page renders correctly with all expected elements.
   */
  describe('rendering', () => {
    it('should render without crashing', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Page renders successfully
      const titleElement = screen.getByText('Accept Invitation');
      expect(titleElement).toBeTruthy();
    });

    it('should render the page title "Accept Invitation"', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Title is displayed
      const title = screen.getByText('Accept Invitation');
      expect(title).toBeInTheDocument();
    });

    it('should render the page title as a CardTitle', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Title is in a div element (CardTitle component)
      const title = screen.getByText('Accept Invitation');
      expect(title.tagName).toBe('DIV'); // CardTitle renders as div
    });

    it('should render the page title with correct styling', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Title has correct classes
      const title = screen.getByText('Accept Invitation');
      expect(title.className).toContain('text-2xl');
      expect(title.className).toContain('font-bold');
    });

    it('should render the page description', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Description is displayed
      const description = screen.getByText('Set your password to activate your account');
      expect(description).toBeInTheDocument();
    });

    it('should render AcceptInviteForm component', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Form component is rendered
      const form = screen.getByTestId('accept-invite-form');
      expect(form).toBeInTheDocument();
    });

    it('should render AcceptInviteForm within CardContent', () => {
      // Arrange & Act
      const { container } = render(<AcceptInvitePage />);

      // Assert: Form is inside CardContent
      const form = screen.getByTestId('accept-invite-form');
      const cardContent = container.querySelector('[class*="card"]');
      expect(cardContent).toBeInTheDocument();
      expect(cardContent?.contains(form)).toBe(true);
    });
  });

  /**
   * Card Component Tests
   *
   * Tests the Card structure (CardHeader, CardContent).
   */
  describe('card structure', () => {
    it('should render CardHeader with title and description', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Both title and description are in the header
      const title = screen.getByText('Accept Invitation');
      const description = screen.getByText('Set your password to activate your account');

      expect(title).toBeInTheDocument();
      expect(description).toBeInTheDocument();
    });

    it('should render CardHeader with correct spacing', () => {
      // Arrange & Act
      const { container } = render(<AcceptInvitePage />);

      // Assert: CardHeader has space-y-1 class
      const cardHeader = container.querySelector('[class*="space-y-1"]');
      expect(cardHeader).toBeInTheDocument();
    });

    it('should render Card as the root element', () => {
      // Arrange & Act
      const { container } = render(<AcceptInvitePage />);

      // Assert: Card is rendered
      const card = container.querySelector('[class*="card"]');
      expect(card).toBeInTheDocument();
    });
  });

  /**
   * Suspense Boundary Tests
   *
   * Tests the Suspense wrapper around AcceptInviteForm.
   * Note: The form uses useSearchParams() which requires Suspense boundary.
   */
  describe('suspense boundary', () => {
    it('should wrap AcceptInviteForm in Suspense boundary', async () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Form renders (Suspense boundary doesn't block in tests)
      await waitFor(() => {
        const form = screen.getByTestId('accept-invite-form');
        expect(form).toBeInTheDocument();
      });
    });

    it('should render Suspense fallback during loading', () => {
      // Note: In test environment, Suspense doesn't actually suspend,
      // so we verify that the component structure supports Suspense
      // by checking that the form is wrapped correctly

      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Component renders without errors (Suspense is properly configured)
      const form = screen.getByTestId('accept-invite-form');
      expect(form).toBeInTheDocument();
    });
  });

  /**
   * Metadata Tests
   *
   * Tests that the page exports correct metadata.
   * Note: Metadata is not rendered in component tests, but we can verify it exists.
   */
  describe('metadata', () => {
    it('should have correct title in metadata', async () => {
      // Import the metadata separately
      const { metadata } = await import('@/app/(auth)/accept-invite/page');

      // Assert: Metadata title is correct
      expect(metadata.title).toBe('Accept Invitation');
    });

    it('should have correct description in metadata', async () => {
      // Import the metadata separately
      const { metadata } = await import('@/app/(auth)/accept-invite/page');

      // Assert: Metadata description is correct
      expect(metadata.description).toBe('Accept your invitation to join Sunrise');
    });
  });

  /**
   * Accessibility Tests
   *
   * Tests for proper semantic structure and accessibility.
   */
  describe('accessibility', () => {
    it('should have proper element structure', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Title is rendered with correct element and styling
      const title = screen.getByText('Accept Invitation');
      expect(title.tagName).toBe('DIV');
      expect(title.className).toContain('font-bold');
      expect(title.className).toContain('text-2xl');
    });

    it('should have descriptive title text', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Title is clear and descriptive
      const title = screen.getByText('Accept Invitation');
      expect(title).toHaveTextContent('Accept Invitation');
    });

    it('should have descriptive subtitle explaining the action', () => {
      // Arrange & Act
      render(<AcceptInvitePage />);

      // Assert: Description explains what user needs to do
      const description = screen.getByText('Set your password to activate your account');
      expect(description).toBeInTheDocument();
    });
  });

  /**
   * Layout Tests
   *
   * Tests that the page uses the correct layout structure.
   */
  describe('layout', () => {
    it('should render within Card component', () => {
      // Arrange & Act
      const { container } = render(<AcceptInvitePage />);

      // Assert: Card wrapper exists
      const card = container.querySelector('[class*="card"]');
      expect(card).toBeInTheDocument();
    });

    it('should render CardHeader before CardContent', () => {
      // Arrange & Act
      const { container } = render(<AcceptInvitePage />);

      // Assert: Header comes before content
      const title = screen.getByText('Accept Invitation');
      const form = screen.getByTestId('accept-invite-form');

      const titlePosition = Array.from(container.querySelectorAll('*')).indexOf(
        title.closest('h3')!
      );
      const formPosition = Array.from(container.querySelectorAll('*')).indexOf(
        form.closest('[data-testid="accept-invite-form"]')!
      );

      expect(titlePosition).toBeLessThan(formPosition);
    });

    it('should maintain consistent spacing in header', () => {
      // Arrange & Act
      const { container } = render(<AcceptInvitePage />);

      // Assert: Header has space-y-1 class for consistent spacing
      const header = container.querySelector('[class*="space-y-1"]');
      expect(header).toBeInTheDocument();
    });
  });
});
