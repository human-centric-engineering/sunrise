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
 * - Inline scripts receive nonce prop when provided
 * - External scripts do not receive nonce prop
 * - Nonce is optional (existing behaviour preserved when omitted)
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

    it('should render nothing when consent is undefined (indeterminate pending-consent state)', () => {
      // Arrange — useHasOptionalConsent returns undefined before the user
      // has responded to the consent banner; scripts must not load yet.
      mockUseHasOptionalConsent.mockReturnValue(undefined);
      mockDetectProvider.mockReturnValue('ga4');

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert — treat undefined the same as false: no scripts rendered
      expect(container.firstChild).toBeNull();
    });

    it('should render nothing when consent is null', () => {
      // Arrange — useHasOptionalConsent may return null before consent state resolves.
      // The falsy guard (!hasConsent) must treat null the same as false/undefined.
      mockUseHasOptionalConsent.mockReturnValue(null);
      mockDetectProvider.mockReturnValue('ga4');

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert — all nullish values prevent script loading
      expect(container.firstChild).toBeNull();
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
      const { container } = render(<AnalyticsScripts />);

      // Assert — contract: exactly 2 scripts (gtag loader + gtag-init).
      // The mock renders inline scripts with their id as data-testid and external
      // scripts without id as data-testid="script"; query by the shared
      // data-component attribute to count all rendered Next.js Script elements.
      // A weaker assertion (toBeGreaterThan) would silently pass if an
      // accidental third script were introduced in a future refactor.
      const scripts = container.querySelectorAll('[data-component="next-script"]');
      expect(scripts).toHaveLength(2);
    });

    it('should render gtag.js script with measurement ID', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue({ measurementId: 'G-ABCD1234' });

      // Act
      render(<AnalyticsScripts />);

      // Assert — select the external gtag.js script by filtering on its src attribute value
      const allScripts = screen.getAllByTestId('script');
      const gtagScript = allScripts.find((el) =>
        el.getAttribute('data-src')?.includes('gtag/js?id=')
      );

      expect(gtagScript?.getAttribute('data-src')).toBe(
        'https://www.googletagmanager.com/gtag/js?id=G-ABCD1234'
      );
      expect(gtagScript?.getAttribute('data-strategy')).toBe('afterInteractive');
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

      // Assert — both the external gtag.js script AND the inline gtag-init script
      // must use afterInteractive. getAllByTestId('script') only returns external scripts
      // (no id); the inline gtag-init script has a different testId so must be checked separately.
      const externalScripts = screen.getAllByTestId('script');
      externalScripts.forEach((script) => {
        expect(script.getAttribute('data-strategy')).toBe('afterInteractive');
      });
      expect(screen.getByTestId('gtag-init').getAttribute('data-strategy')).toBe(
        'afterInteractive'
      );
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

    it('renders nothing when GA4 config is undefined', () => {
      // Arrange — undefined is the other falsy return a config getter might produce;
      // the null guard in GA4Scripts must handle both null and undefined.
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('ga4');
      mockGetGA4Config.mockReturnValue(undefined);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert — no scripts should be rendered
      expect(container.firstChild).toBeNull();
      expect(container.querySelectorAll('[data-component="next-script"]')).toHaveLength(0);
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

    it('renders nothing when PostHog config is undefined', () => {
      // Arrange — undefined is the other falsy return a config getter might produce;
      // the null guard in PostHogScripts must handle both null and undefined.
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('posthog');
      mockGetPostHogConfig.mockReturnValue(undefined);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert — no scripts should be rendered
      expect(container.firstChild).toBeNull();
      expect(container.querySelectorAll('[data-component="next-script"]')).toHaveLength(0);
    });

    it('should not inline apiKey or host in the PostHog stub script', () => {
      // Arrange — the source explicitly states PostHogProvider owns init;
      // the stub must NOT duplicate apiKey/host inline. This is a regression
      // guard against an accidental inline posthog.init() call being added.
      const fixtureApiKey = 'phc_fixture_key_abc123';
      const fixtureHost = 'https://fixture.posthog.example.com';
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('posthog');
      mockGetPostHogConfig.mockReturnValue({
        apiKey: fixtureApiKey,
        host: fixtureHost,
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert — stub text must not contain either resolved config value
      const stubScript = screen.getByTestId('posthog-stub');
      const scriptText = stubScript.textContent ?? '';
      expect(scriptText).not.toContain(fixtureApiKey);
      expect(scriptText).not.toContain(fixtureHost);
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
      const { container } = render(<AnalyticsScripts />);

      // Assert — contract: exactly 2 scripts (script.js loader + plausible-init).
      // The mock renders inline scripts with their id as data-testid and external
      // scripts without id as data-testid="script"; query by the shared
      // data-component attribute to count all rendered Next.js Script elements.
      // A weaker assertion (toBeGreaterThan) would silently pass if an
      // accidental third script were introduced in a future refactor.
      const scripts = container.querySelectorAll('[data-component="next-script"]');
      expect(scripts).toHaveLength(2);
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

      // Assert — use getAllByTestId to get a descriptive failure if the element is missing,
      // rather than .find() which returns undefined and causes a confusing chained-attribute throw.
      // The plausible.io external script is the only script with a data-src containing 'plausible.io'.
      const allScripts = screen.getAllByTestId('script');
      const plausibleScript = allScripts.find((el) =>
        el.getAttribute('data-src')?.includes('plausible.io')
      );
      expect(plausibleScript).not.toBeUndefined();
      expect(plausibleScript!.getAttribute('data-domain')).toBe('mysite.com');
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

      // Assert — select the external script and assert its src attribute directly.
      // Also assert data-domain so a regression that drops the attribute on the custom-host
      // code path would be caught here (complements the plausible.io host test above).
      const allScripts = screen.getAllByTestId('script');
      const plausibleScript = allScripts.find((el) =>
        el.getAttribute('data-src')?.includes('/js/script.js')
      );

      expect(plausibleScript?.getAttribute('data-src')).toBe(
        'https://analytics.example.com/js/script.js'
      );
      expect(plausibleScript?.getAttribute('data-domain')).toBe('example.com');
    });

    it('should normalize Plausible host with trailing slash', () => {
      // Arrange
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue({
        domain: 'example.com',
        host: 'https://plausible.example.com/',
      });

      // Act
      render(<AnalyticsScripts />);

      // Assert — trailing slash on host must not produce `//js/script.js`
      const plausibleScript = screen
        .getAllByTestId('script')
        .find((el) => el.getAttribute('data-src')?.includes('/js/script.js'));

      expect(plausibleScript?.getAttribute('data-src')).toBe(
        'https://plausible.example.com/js/script.js'
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

      // Assert — both the external script.js script AND the inline plausible-init script
      // must use afterInteractive. getAllByTestId('script') only returns external scripts
      // (no id); the inline plausible-init script has a different testId so must be checked separately.
      const externalScripts = screen.getAllByTestId('script');
      externalScripts.forEach((script) => {
        expect(script.getAttribute('data-strategy')).toBe('afterInteractive');
      });
      expect(screen.getByTestId('plausible-init').getAttribute('data-strategy')).toBe(
        'afterInteractive'
      );
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

    it('renders nothing when Plausible config is undefined', () => {
      // Arrange — undefined is the other falsy return a config getter might produce;
      // the null guard in PlausibleScripts must handle both null and undefined.
      mockUseHasOptionalConsent.mockReturnValue(true);
      mockDetectProvider.mockReturnValue('plausible');
      mockGetPlausibleConfig.mockReturnValue(undefined);

      // Act
      const { container } = render(<AnalyticsScripts />);

      // Assert — no scripts should be rendered
      expect(container.firstChild).toBeNull();
      expect(container.querySelectorAll('[data-component="next-script"]')).toHaveLength(0);
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

  describe('nonce prop', () => {
    describe('without nonce (optional behaviour preserved)', () => {
      it('should render GA4 inline script without nonce attribute when nonce is not provided', () => {
        // Arrange
        mockUseHasOptionalConsent.mockReturnValue(true);
        mockDetectProvider.mockReturnValue('ga4');
        mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

        // Act
        render(<AnalyticsScripts />);

        // Assert — nonce attribute should be absent (null) when not supplied
        const initScript = screen.getByTestId('gtag-init');
        expect(initScript.getAttribute('nonce')).toBeNull();
      });

      it('should render GA4 external script without a nonce when nonce omitted', () => {
        // Arrange — no nonce passed to AnalyticsScripts
        mockUseHasOptionalConsent.mockReturnValue(true);
        mockDetectProvider.mockReturnValue('ga4');
        mockGetGA4Config.mockReturnValue({ measurementId: 'G-ABCD1234' });

        // Act
        render(<AnalyticsScripts />);

        // Assert — the external gtag.js Script element must have no nonce attribute
        const allScripts = screen.getAllByTestId('script');
        const gtagScript = allScripts.find((el) =>
          el.getAttribute('data-src')?.includes('gtag/js?id=')
        );

        expect(gtagScript?.getAttribute('nonce')).toBeNull();
      });

      it('should render PostHog inline script without nonce attribute when nonce is not provided', () => {
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
        expect(stubScript.getAttribute('nonce')).toBeNull();
      });

      it('should render Plausible inline script without nonce attribute when nonce is not provided', () => {
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
        expect(initScript.getAttribute('nonce')).toBeNull();
      });
    });

    describe('with nonce provided', () => {
      it('should pass nonce to GA4 inline gtag-init script', () => {
        // Arrange
        mockUseHasOptionalConsent.mockReturnValue(true);
        mockDetectProvider.mockReturnValue('ga4');
        mockGetGA4Config.mockReturnValue({ measurementId: 'G-TEST123' });

        // Act
        render(<AnalyticsScripts nonce="test-nonce-abc" />);

        // Assert — inline script receives the nonce
        const initScript = screen.getByTestId('gtag-init');
        expect(initScript.getAttribute('nonce')).toBe('test-nonce-abc');
      });

      it('should NOT pass nonce to GA4 external gtag.js script', () => {
        // Arrange
        mockUseHasOptionalConsent.mockReturnValue(true);
        mockDetectProvider.mockReturnValue('ga4');
        mockGetGA4Config.mockReturnValue({ measurementId: 'G-ABCD1234' });

        // Act
        render(<AnalyticsScripts nonce="test-nonce-abc" />);

        // Assert — external script (no id) does NOT get a nonce
        const externalScript = screen
          .getAllByTestId('script')
          .find((el) => el.getAttribute('data-src')?.includes('googletagmanager.com'));

        expect(externalScript).toBeDefined();
        expect(externalScript?.getAttribute('nonce')).toBeNull();
      });

      it('should pass nonce to PostHog inline posthog-stub script', () => {
        // Arrange
        mockUseHasOptionalConsent.mockReturnValue(true);
        mockDetectProvider.mockReturnValue('posthog');
        mockGetPostHogConfig.mockReturnValue({
          apiKey: 'phc_test123',
          host: 'https://us.i.posthog.com',
        });

        // Act
        render(<AnalyticsScripts nonce="test-nonce-xyz" />);

        // Assert — inline stub script receives the nonce
        const stubScript = screen.getByTestId('posthog-stub');
        expect(stubScript.getAttribute('nonce')).toBe('test-nonce-xyz');
      });

      it('should pass nonce to Plausible inline plausible-init script', () => {
        // Arrange
        mockUseHasOptionalConsent.mockReturnValue(true);
        mockDetectProvider.mockReturnValue('plausible');
        mockGetPlausibleConfig.mockReturnValue({
          domain: 'example.com',
          host: 'https://plausible.io',
        });

        // Act
        render(<AnalyticsScripts nonce="test-nonce-pla" />);

        // Assert — inline init script receives the nonce
        const initScript = screen.getByTestId('plausible-init');
        expect(initScript.getAttribute('nonce')).toBe('test-nonce-pla');
      });

      it('should NOT pass nonce to Plausible external script.js script', () => {
        // Arrange
        mockUseHasOptionalConsent.mockReturnValue(true);
        mockDetectProvider.mockReturnValue('plausible');
        mockGetPlausibleConfig.mockReturnValue({
          domain: 'example.com',
          host: 'https://plausible.io',
        });

        // Act
        render(<AnalyticsScripts nonce="test-nonce-pla" />);

        // Assert — external script (no id) does NOT get a nonce
        const externalScript = screen
          .getAllByTestId('script')
          .find((el) => el.getAttribute('data-src')?.includes('plausible.io'));

        expect(externalScript).toBeDefined();
        expect(externalScript?.getAttribute('nonce')).toBeNull();
      });
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
