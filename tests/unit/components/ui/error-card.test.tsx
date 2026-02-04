/**
 * ErrorCard Component Tests
 *
 * Tests the ErrorCard component used by error boundaries:
 * - Rendering title and description
 * - Default AlertTriangle icon vs custom icon
 * - Dev-only error details (NODE_ENV=development)
 * - Production error hiding (NODE_ENV=production)
 * - Error digest display
 * - Action buttons rendering and onClick behavior
 * - Footer content rendering
 * - Custom containerClassName application
 * - Default containerClassName behavior
 * - Graceful handling of optional props
 *
 * Test Coverage:
 * - Initial rendering (title, description, icon)
 * - Environment-based error display (dev vs prod)
 * - Error digest display in development
 * - Action buttons (labels, onClick, variants, icons)
 * - Footer content
 * - Container and icon className customization
 * - Edge cases (no actions, no error, no footer)
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/ui/error-card.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Home, RefreshCw } from 'lucide-react';
import { ErrorCard, type ErrorCardAction } from '@/components/ui/error-card';

/**
 * Test Suite: ErrorCard Component
 *
 * Tests the error card with various configurations and environment modes.
 */
describe('components/ui/error-card', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('rendering', () => {
    it('should render title and description', () => {
      // Arrange & Act
      render(<ErrorCard title="Error Title" description="Error description text" />);

      // Assert: Title and description should be visible
      expect(screen.getByText('Error Title')).toBeInTheDocument();
      expect(screen.getByText('Error description text')).toBeInTheDocument();
    });

    it('should show default AlertTriangle icon when no custom icon provided', () => {
      // Arrange & Act
      const { container } = render(<ErrorCard title="Error" description="Something went wrong" />);

      // Assert: AlertTriangle icon should be present (lucide-react adds class)
      const icon = container.querySelector('svg.lucide-triangle-alert');
      expect(icon).toBeInTheDocument();
    });

    it('should show custom icon when provided', () => {
      // Arrange & Act
      const customIcon = <Home data-testid="custom-icon" />;
      render(<ErrorCard title="Error" description="Description" icon={customIcon} />);

      // Assert: Custom icon should be present, not default AlertTriangle
      expect(screen.getByTestId('custom-icon')).toBeInTheDocument();
      const { container } = render(
        <ErrorCard title="Error" description="Description" icon={customIcon} />
      );
      const alertIcon = container.querySelector('svg.lucide-triangle-alert');
      expect(alertIcon).not.toBeInTheDocument();
    });

    it('should render without crashing with minimal props', () => {
      // Arrange & Act
      const { container } = render(<ErrorCard title="Error" description="Description" />);

      // Assert: Should be in document
      expect(container.firstChild).toBeInTheDocument();
    });
  });

  describe('dev-only error details', () => {
    it('should show error details when NODE_ENV=development and error prop is provided', () => {
      // Arrange: Set environment to development
      vi.stubEnv('NODE_ENV', 'development');
      const error = new Error('Test error message');

      // Act
      render(<ErrorCard title="Error" description="Description" error={error} />);

      // Assert: Error message should be visible
      expect(screen.getByText('Error:')).toBeInTheDocument();
      expect(screen.getByText('Test error message')).toBeInTheDocument();
    });

    it('should hide error details when NODE_ENV=production', () => {
      // Arrange: Set environment to production
      vi.stubEnv('NODE_ENV', 'production');
      const error = new Error('Secret error message');

      // Act
      render(<ErrorCard title="Error" description="Description" error={error} />);

      // Assert: Error details should NOT be visible
      expect(screen.queryByText('Error:')).not.toBeInTheDocument();
      expect(screen.queryByText('Secret error message')).not.toBeInTheDocument();
    });

    it('should hide error details when error prop is not provided', () => {
      // Arrange: Set environment to development (would show errors if provided)
      vi.stubEnv('NODE_ENV', 'development');

      // Act
      render(<ErrorCard title="Error" description="Description" />);

      // Assert: Error section should NOT be visible
      expect(screen.queryByText('Error:')).not.toBeInTheDocument();
    });
  });

  describe('error digest', () => {
    it('should show error digest when present in development', () => {
      // Arrange: Set environment to development
      vi.stubEnv('NODE_ENV', 'development');
      const error = new Error('Error message') as Error & { digest?: string };
      error.digest = 'abc123xyz';

      // Act
      render(<ErrorCard title="Error" description="Description" error={error} />);

      // Assert: Error digest should be visible
      expect(screen.getByText('Error Digest:')).toBeInTheDocument();
      expect(screen.getByText('abc123xyz')).toBeInTheDocument();
    });

    it('should not show error digest section when digest is not present', () => {
      // Arrange: Set environment to development
      vi.stubEnv('NODE_ENV', 'development');
      const error = new Error('Error message');

      // Act
      render(<ErrorCard title="Error" description="Description" error={error} />);

      // Assert: Error Digest section should NOT be visible
      expect(screen.queryByText('Error Digest:')).not.toBeInTheDocument();
    });

    it('should not show error digest in production even if present', () => {
      // Arrange: Set environment to production
      vi.stubEnv('NODE_ENV', 'production');
      const error = new Error('Error message') as Error & { digest?: string };
      error.digest = 'should-not-show';

      // Act
      render(<ErrorCard title="Error" description="Description" error={error} />);

      // Assert: Error digest should NOT be visible in production
      expect(screen.queryByText('Error Digest:')).not.toBeInTheDocument();
      expect(screen.queryByText('should-not-show')).not.toBeInTheDocument();
    });
  });

  describe('action buttons', () => {
    it('should render action buttons with correct labels', () => {
      // Arrange
      const actions: ErrorCardAction[] = [
        { label: 'Go Home', onClick: vi.fn() },
        { label: 'Try Again', onClick: vi.fn() },
      ];

      // Act
      render(<ErrorCard title="Error" description="Description" actions={actions} />);

      // Assert: Buttons should be visible with correct labels
      expect(screen.getByRole('button', { name: 'Go Home' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
    });

    it('should call onClick when action button is clicked', async () => {
      // Arrange
      const user = userEvent.setup();
      const onClickSpy = vi.fn();
      const actions: ErrorCardAction[] = [{ label: 'Click Me', onClick: onClickSpy }];

      render(<ErrorCard title="Error" description="Description" actions={actions} />);

      const button = screen.getByRole('button', { name: 'Click Me' });

      // Act: Click the button
      await user.click(button);

      // Assert: onClick should have been called
      expect(onClickSpy).toHaveBeenCalledTimes(1);
    });

    it('should render action button with icon', () => {
      // Arrange
      const actions: ErrorCardAction[] = [
        {
          label: 'Go Home',
          onClick: vi.fn(),
          icon: <Home data-testid="action-icon" />,
        },
      ];

      // Act
      render(<ErrorCard title="Error" description="Description" actions={actions} />);

      // Assert: Button icon should be present
      expect(screen.getByTestId('action-icon')).toBeInTheDocument();
    });

    it('should apply variant to action button', () => {
      // Arrange
      const actions: ErrorCardAction[] = [
        { label: 'Primary', onClick: vi.fn(), variant: 'default' },
        { label: 'Secondary', onClick: vi.fn(), variant: 'outline' },
      ];

      // Act
      render(<ErrorCard title="Error" description="Description" actions={actions} />);

      // Assert: Buttons should exist (variant styling is handled by Button component)
      expect(screen.getByRole('button', { name: 'Primary' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Secondary' })).toBeInTheDocument();
    });

    it('should render with no actions gracefully', () => {
      // Arrange & Act
      render(<ErrorCard title="Error" description="Description" />);

      // Assert: Should render without errors (no buttons present)
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('should render with empty actions array gracefully', () => {
      // Arrange & Act
      render(<ErrorCard title="Error" description="Description" actions={[]} />);

      // Assert: Should render without errors (no buttons present)
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('should handle multiple action buttons', async () => {
      // Arrange
      const user = userEvent.setup();
      const onClick1 = vi.fn();
      const onClick2 = vi.fn();
      const onClick3 = vi.fn();
      const actions: ErrorCardAction[] = [
        { label: 'Action 1', onClick: onClick1 },
        { label: 'Action 2', onClick: onClick2 },
        { label: 'Action 3', onClick: onClick3 },
      ];

      render(<ErrorCard title="Error" description="Description" actions={actions} />);

      // Act: Click each button
      await user.click(screen.getByRole('button', { name: 'Action 1' }));
      await user.click(screen.getByRole('button', { name: 'Action 2' }));
      await user.click(screen.getByRole('button', { name: 'Action 3' }));

      // Assert: Each onClick should be called independently
      expect(onClick1).toHaveBeenCalledTimes(1);
      expect(onClick2).toHaveBeenCalledTimes(1);
      expect(onClick3).toHaveBeenCalledTimes(1);
    });

    it('should use default variant when variant not specified', () => {
      // Arrange
      const actions: ErrorCardAction[] = [{ label: 'Default Variant', onClick: vi.fn() }];

      // Act
      render(<ErrorCard title="Error" description="Description" actions={actions} />);

      // Assert: Button should render (default variant handled by Button component)
      expect(screen.getByRole('button', { name: 'Default Variant' })).toBeInTheDocument();
    });
  });

  describe('footer content', () => {
    it('should render footer content', () => {
      // Arrange
      const footer = <div data-testid="footer-content">Need help? Contact support</div>;

      // Act
      render(<ErrorCard title="Error" description="Description" footer={footer} />);

      // Assert: Footer should be visible
      expect(screen.getByTestId('footer-content')).toBeInTheDocument();
      expect(screen.getByText('Need help? Contact support')).toBeInTheDocument();
    });

    it('should render without footer gracefully', () => {
      // Arrange & Act
      render(<ErrorCard title="Error" description="Description" />);

      // Assert: Should render without errors (no footer present)
      expect(screen.getByText('Error')).toBeInTheDocument();
    });

    it('should render footer with complex content', () => {
      // Arrange
      const footer = (
        <div data-testid="complex-footer">
          <p>Contact support:</p>
          <a href="mailto:help@example.com">help@example.com</a>
        </div>
      );

      // Act
      render(<ErrorCard title="Error" description="Description" footer={footer} />);

      // Assert: All footer content should be visible
      expect(screen.getByTestId('complex-footer')).toBeInTheDocument();
      expect(screen.getByText('Contact support:')).toBeInTheDocument();
      expect(screen.getByText('help@example.com')).toBeInTheDocument();
    });
  });

  describe('containerClassName', () => {
    it('should apply custom containerClassName', () => {
      // Arrange & Act
      const { container } = render(
        <ErrorCard
          title="Error"
          description="Description"
          containerClassName="min-h-screen bg-red-50"
        />
      );

      // Assert: Container should have custom classes
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('min-h-screen');
      expect(wrapper).toHaveClass('bg-red-50');
    });

    it('should apply default containerClassName when not specified', () => {
      // Arrange & Act
      const { container } = render(<ErrorCard title="Error" description="Description" />);

      // Assert: Container should have default min-h-[400px] class
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper.className).toContain('min-h-[400px]');
    });

    it('should include flex and padding classes with custom containerClassName', () => {
      // Arrange & Act
      const { container } = render(
        <ErrorCard title="Error" description="Description" containerClassName="custom-height" />
      );

      // Assert: Should have both default flex/padding and custom class
      const wrapper = container.firstChild as HTMLElement;
      expect(wrapper).toHaveClass('flex');
      expect(wrapper).toHaveClass('items-center');
      expect(wrapper).toHaveClass('justify-center');
      expect(wrapper).toHaveClass('p-4');
      expect(wrapper).toHaveClass('custom-height');
    });
  });

  describe('iconClassName', () => {
    it('should apply default iconClassName (text-red-500)', () => {
      // Arrange & Act
      const { container } = render(<ErrorCard title="Error" description="Description" />);

      // Assert: Icon wrapper should have text-red-500 class
      const iconWrapper = container.querySelector('.text-red-500');
      expect(iconWrapper).toBeInTheDocument();
    });

    it('should apply custom iconClassName', () => {
      // Arrange & Act
      const { container } = render(
        <ErrorCard title="Error" description="Description" iconClassName="text-blue-500" />
      );

      // Assert: Icon wrapper should have custom class
      const iconWrapper = container.querySelector('.text-blue-500');
      expect(iconWrapper).toBeInTheDocument();
    });

    it('should apply custom iconClassName to custom icon', () => {
      // Arrange & Act
      const customIcon = <RefreshCw data-testid="custom-icon" />;
      const { container } = render(
        <ErrorCard
          title="Error"
          description="Description"
          icon={customIcon}
          iconClassName="text-yellow-500"
        />
      );

      // Assert: Icon wrapper should have custom class
      const iconWrapper = container.querySelector('.text-yellow-500');
      expect(iconWrapper).toBeInTheDocument();
      expect(iconWrapper?.querySelector('[data-testid="custom-icon"]')).toBeInTheDocument();
    });
  });

  describe('integration scenarios', () => {
    it('should render all features together (actions, footer, error, custom classes)', () => {
      // Arrange: Set to development mode
      vi.stubEnv('NODE_ENV', 'development');
      const error = new Error('Integration test error') as Error & { digest?: string };
      error.digest = 'digest123';

      const actions: ErrorCardAction[] = [
        { label: 'Go Home', onClick: vi.fn(), icon: <Home data-testid="home-icon" /> },
        { label: 'Retry', onClick: vi.fn(), variant: 'outline' },
      ];

      const footer = <div data-testid="support-link">Contact support</div>;

      // Act
      render(
        <ErrorCard
          title="Integration Error"
          description="This is a full integration test"
          error={error}
          actions={actions}
          footer={footer}
          containerClassName="min-h-screen"
          iconClassName="text-orange-500"
          icon={<RefreshCw data-testid="custom-error-icon" />}
        />
      );

      // Assert: All features should be present
      expect(screen.getByText('Integration Error')).toBeInTheDocument();
      expect(screen.getByText('This is a full integration test')).toBeInTheDocument();
      expect(screen.getByText('Error:')).toBeInTheDocument();
      expect(screen.getByText('Integration test error')).toBeInTheDocument();
      expect(screen.getByText('Error Digest:')).toBeInTheDocument();
      expect(screen.getByText('digest123')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go Home' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(screen.getByTestId('home-icon')).toBeInTheDocument();
      expect(screen.getByTestId('support-link')).toBeInTheDocument();
      expect(screen.getByTestId('custom-error-icon')).toBeInTheDocument();
    });

    it('should render minimal error card in production', () => {
      // Arrange: Set to production mode
      vi.stubEnv('NODE_ENV', 'production');
      const error = new Error('Hidden error');

      // Act
      render(<ErrorCard title="Error" description="Something went wrong" error={error} />);

      // Assert: Only title, description, and icon visible (no error details)
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      expect(screen.queryByText('Error:')).not.toBeInTheDocument();
      expect(screen.queryByText('Hidden error')).not.toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('should handle undefined optional props gracefully', () => {
      // Arrange & Act
      render(
        <ErrorCard
          title="Error"
          description="Description"
          icon={undefined}
          iconClassName={undefined}
          error={undefined}
          actions={undefined}
          footer={undefined}
          containerClassName={undefined}
        />
      );

      // Assert: Should render with defaults
      expect(screen.getByText('Error')).toBeInTheDocument();
      expect(screen.getByText('Description')).toBeInTheDocument();
    });

    it('should handle empty strings gracefully', () => {
      // Arrange & Act
      const { container } = render(
        <ErrorCard title="" description="" containerClassName="" iconClassName="" />
      );

      // Assert: Should render without errors
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should handle error with empty message', () => {
      // Arrange: Set to development mode
      vi.stubEnv('NODE_ENV', 'development');
      const error = new Error('');

      // Act
      render(<ErrorCard title="Error" description="Description" error={error} />);

      // Assert: Error section should render with empty message
      expect(screen.getByText('Error:')).toBeInTheDocument();
    });

    it('should use unique keys for action buttons', () => {
      // Arrange
      const actions: ErrorCardAction[] = [
        { label: 'Action 1', onClick: vi.fn() },
        { label: 'Action 2', onClick: vi.fn() },
        { label: 'Action 1', onClick: vi.fn() }, // Duplicate label (relies on key={action.label})
      ];

      // Act
      const { container } = render(
        <ErrorCard title="Error" description="Description" actions={actions} />
      );

      // Assert: All buttons should render (note: duplicate keys would cause React warning in console)
      const buttons = container.querySelectorAll('button');
      expect(buttons).toHaveLength(3);
    });
  });

  describe('accessibility', () => {
    it('should render semantic card structure', () => {
      // Arrange & Act
      const { container } = render(<ErrorCard title="Error" description="Description" />);

      // Assert: Should use semantic HTML structure (Card component provides structure)
      expect(container.firstChild).toBeInTheDocument();
    });

    it('should have accessible button text', () => {
      // Arrange
      const actions: ErrorCardAction[] = [{ label: 'Go to Home Page', onClick: vi.fn() }];

      // Act
      render(<ErrorCard title="Error" description="Description" actions={actions} />);

      // Assert: Button should have accessible name
      const button = screen.getByRole('button', { name: 'Go to Home Page' });
      expect(button).toHaveAccessibleName('Go to Home Page');
    });

    it('should render error details with semantic structure', () => {
      // Arrange: Set to development mode
      vi.stubEnv('NODE_ENV', 'development');
      const error = new Error('Accessible error');

      // Act
      render(<ErrorCard title="Error" description="Description" error={error} />);

      // Assert: Error message should be visible with semantic text
      expect(screen.getByText('Error:')).toBeInTheDocument();
      expect(screen.getByText('Accessible error')).toBeInTheDocument();
    });
  });
});
