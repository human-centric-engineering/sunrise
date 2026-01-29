/**
 * AnalyticsScripts Component Tests
 *
 * Tests the AnalyticsScripts component which conditionally loads
 * analytics provider scripts based on configuration and consent.
 *
 * Features tested:
 * - Renders nothing when consent not given
 * - Renders nothing for console provider
 * - Renders GA4 script tags with correct measurement ID
 * - Renders PostHog stub/bootstrap script
 * - Renders Plausible script with domain attribute
 * - Script tags have correct src attributes and data attributes
 *
 * @see /Users/simonholmes/Documents/Dev/studio/sunrise/components/analytics/analytics-scripts.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AnalyticsScripts } from '@/components/analytics/analytics-scripts';

// Mock dependencies
const mockUseHasOptionalConsent = vi.fn();
const mockDetectProvider = vi.fn();
const mockGetGA4Config = vi.fn();
const mockGetPostHogConfig = vi.fn();
const mockGetPlausibleConfig = vi.fn();

vi.mock('@/lib/consent', () => ({
  useHasOptionalConsent: () => mockUseHasOptionalConsent(),
}));

vi.mock('@/lib/analytics/config', () => ({
  detectProvider: () => mockDetectProvider(),
  getGA4Config: () => mockGetGA4Config(),
  getPostHogConfig: () => mockGetPostHogConfig(),
  getPlausibleConfig: () => mockGetPlausibleConfig(),
}));

// Mock Next.js Script component
vi.mock('next/script', () => ({
  default: ({ children, id, src, strategy, ...props }: any) => (
    <script
      data-testid={id || 'script'}
      data-src={src}
      data-strategy={strategy}
      data-component="next-script"
      {...props}
    >
      {children}
    </script>
  ),
}));

/**
 * Test Suite: AnalyticsScripts Component
 */
describe('components/analytics/analytics-scripts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('consent handling', () => {
    it('should render nothing when consent not given', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(false);
      mockDetectProvider.mockReturnValue('ga4');

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should not load scripts when consent is false', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(false);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      expect(screen.queryByTestId('script')).not.toBeInTheDocument();
      expect(screen.queryByTestId('gtag-init')).not.toBeInTheDocument();
    });
  });

  describe('console provider', () => {
    it('should render nothing for console provider', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('console');

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert
      expect(container.firstChild).toBeNull();
    });

    it('should not load any scripts for console provider', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('console');

      // Act
      render(<AnalyticsScripts />);

      // Assert
      expect(screen.queryByTestId('script')).not.toBeInTheDocument();
    });
  });

  describe('no provider', () => {
    it('should render nothing when no provider detected', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue(null);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert
      expect(container.firstChild).toBeNull();
    });
  });

  describe('GA4 provider', () => {
    it('should render GA4 scripts when provider is ga4', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const scripts = screen.getAllByTestId('script');
      expect(scripts.length).toBeGreaterThan(0);
    });

    it('should render gtag.js script with measurement ID', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-ABCD1234' });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const gtagScript = screen
        .getAllByTestId('script')
        .find((el) => el.getAttribute('data-src')?.includes('googletagmanager.com'));

      expect(gtagScript).toBeDefined();
      expect(gtagScript?.getAttribute('data-src')).toContain('G-ABCD1234');
      expect(gtagScript?.getAttribute('data-src')).toBe(
        'https://www.googletagmanager.com/gtag/js?id=G-ABCD1234'
      );
    });

    it('should render gtag init script', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const initScript = screen.getByTestId('gtag-init');
      expect(initScript).toBeInTheDocument();
      expect(initScript.textContent).toContain('window.dataLayer');
      expect(initScript.textContent).toContain('function gtag()');
    });

    it('should use afterInteractive strategy for GA4 scripts', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const scripts = screen.getAllByTestId('script');
      scripts.forEach((script) => {
        expect(script.getAttribute('data-strategy')).toBe('afterInteractive');
      });
    });

    it('should render nothing if GA4 config is null', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue(null);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert
      expect(container.firstChild).toBeNull();
    });
  });

  describe('PostHog provider', () => {
    it('should render PostHog stub script when provider is posthog', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('posthog');
      mockGetPostHogConfig.mockReturnValue({
        apiKey: 'phc_test123',
        host: 'https://us.i.posthog.com',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const stubScript = screen.getByTestId('posthog-stub');
      expect(stubScript).toBeInTheDocument();
    });

    it('should include PostHog initialization stub code', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('posthog');
      mockGetPostHogConfig.mockReturnValue({
        apiKey: 'phc_test123',
        host: 'https://us.i.posthog.com',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const stubScript = screen.getByTestId('posthog-stub');
      expect(stubScript.textContent).toContain('window.posthog');
      expect(stubScript.textContent).toContain('e.init=function');
      expect(stubScript.textContent).toContain('__SV');
    });

    it('should use afterInteractive strategy for PostHog script', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('posthog');
      mockGetPostHogConfig.mockReturnValue({
        apiKey: 'phc_test123',
        host: 'https://us.i.posthog.com',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const stubScript = screen.getByTestId('posthog-stub');
      expect(stubScript.getAttribute('data-strategy')).toBe('afterInteractive');
    });

    it('should render nothing if PostHog config is null', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('posthog');
      mockGetPostHogConfig.mockReturnValue(null);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert
      expect(container.firstChild).toBeNull();
    });
  });

  describe('Plausible provider', () => {
    it('should render Plausible scripts when provider is plausible', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue({
        domain: 'example.com',
        host: 'https://plausible.io',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const scripts = screen.getAllByTestId('script');
      expect(scripts.length).toBeGreaterThan(0);
    });

    it('should render Plausible script with domain attribute', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue({
        domain: 'mysite.com',
        host: 'https://plausible.io',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const plausibleScript = screen
        .getAllByTestId('script')
        .find((el) => el.getAttribute('data-src')?.includes('plausible.io'));

      expect(plausibleScript).toBeDefined();
      expect(plausibleScript?.getAttribute('data-domain')).toBe('mysite.com');
    });

    it('should render Plausible script with correct src URL', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue({
        domain: 'example.com',
        host: 'https://analytics.example.com',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const plausibleScript = screen
        .getAllByTestId('script')
        .find((el) => el.getAttribute('data-src')?.includes('script.js'));

      expect(plausibleScript).toBeDefined();
      expect(plausibleScript?.getAttribute('data-src')).toBe(
        'https://analytics.example.com/js/script.js'
      );
    });

    it('should render Plausible init script', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue({
        domain: 'example.com',
        host: 'https://plausible.io',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const initScript = screen.getByTestId('plausible-init');
      expect(initScript).toBeInTheDocument();
      expect(initScript.textContent).toContain('window.plausible');
    });

    it('should use afterInteractive strategy for Plausible scripts', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue({
        domain: 'example.com',
        host: 'https://plausible.io',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert
      const scripts = screen.getAllByTestId('script');
      scripts.forEach((script) => {
        expect(script.getAttribute('data-strategy')).toBe('afterInteractive');
      });
    });

    it('should render nothing if Plausible config is null', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue(null);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert
      expect(container.firstChild).toBeNull();
    });
  });

  describe('unknown provider', () => {
    it('should render nothing for unknown provider', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      // Testing invalid provider (type assertion needed for test)
      mockDetectProvider.mockReturnValue('unknown-provider' as never);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert
      expect(container.firstChild).toBeNull();
    });
  });

  describe('integration scenarios', () => {
    it('should switch providers when detectProvider changes', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

      const { rerender } = render(<AnalyticsScripts />);

      // Verify GA4 is loaded
      expect(screen.getByTestId('gtag-init')).toBeInTheDocument();

      // Act - Change to PostHog
      mockDetectProvider.mockReturnValue('posthog');
      mockGetPostHogConfig.mockReturnValue({
        apiKey: 'phc_test123',
        host: 'https://us.i.posthog.com',
      });

      rerender(<AnalyticsScripts />);

      // Assert - PostHog is now loaded
      expect(screen.getByTestId('posthog-stub')).toBeInTheDocument();
      expect(screen.queryByTestId('gtag-init')).not.toBeInTheDocument();
    });

    it('should remove scripts when consent is revoked', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

      const { rerender, container } = render(<AnalyticsScripts />);

      // Verify scripts are loaded
      expect(screen.getByTestId('gtag-init')).toBeInTheDocument();

      // Act - Revoke consent
      mockUseHasOptionalConsent.mockReturnValue(false);
      rerender(<AnalyticsScripts />);

      // Assert - No scripts rendered
      expect(container.firstChild).toBeNull();
    });
  });
});
