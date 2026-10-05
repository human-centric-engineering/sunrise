// @vitest-environment happy-dom

/**
 * SetupRequiredBanner Component Tests
 *
 * Test Coverage:
 * - Renders nothing when `hasProvider` is true (post-setup state).
 * - Renders the informational card when `hasProvider` is false.
 * - Mentions the wizard auto-open behaviour and the .env-detection hint.
 *
 * @see components/admin/orchestration/setup-required-banner.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SetupRequiredBanner } from '@/components/admin/orchestration/setup-required-banner';
import { SharedSettingsAccessProvider } from '@/components/admin/shared-settings-access';

describe('SetupRequiredBanner', () => {
  describe('when hasProvider is true', () => {
    it('renders nothing', () => {
      const { container } = render(<SetupRequiredBanner hasProvider={true} />);

      expect(container.firstChild).toBeNull();
    });
  });

  describe('when hasProvider is false', () => {
    it('renders the banner card', () => {
      render(<SetupRequiredBanner hasProvider={false} />);

      expect(screen.getByTestId('setup-required-banner')).toBeInTheDocument();
    });

    it('shows the "no provider configured" headline', () => {
      render(<SetupRequiredBanner hasProvider={false} />);

      expect(screen.getByText(/no llm provider is configured yet/i)).toBeInTheDocument();
    });

    it('mentions the .env detection in the body copy', () => {
      render(<SetupRequiredBanner hasProvider={false} />);

      // The banner explains the wizard auto-detects API keys present
      // in `.env` — both bits of context appear in the same paragraph.
      const body = screen.getByText(/setup wizard has opened/i);
      expect(body).toBeInTheDocument();
      expect(body.textContent).toMatch(/api keys/i);
      expect(body.textContent).toMatch(/\.env/);
    });
  });

  describe('read-only outside the install org (§107 t-753)', () => {
    it('replaces the wizard copy with the install-organisation pointer when read-only', () => {
      // Contrast: the same hasProvider=false fixture without readOnly says the
      // wizard has opened (asserted in "mentions the .env detection" above).
      const { unmount } = render(<SetupRequiredBanner hasProvider={false} />);
      expect(screen.getByText(/setup wizard has opened/i)).toBeInTheDocument();
      unmount();

      render(
        <SharedSettingsAccessProvider readOnly canSwitch>
          <SetupRequiredBanner hasProvider={false} />
        </SharedSettingsAccessProvider>
      );

      expect(screen.queryByText(/setup wizard has opened/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/api keys/i)).not.toBeInTheDocument();
      expect(screen.getByText(/set up from the install\s+organisation/i)).toBeInTheDocument();
      // The banner itself and its headline survive.
      expect(screen.getByTestId('setup-required-banner')).toBeInTheDocument();
      expect(screen.getByText(/no llm provider is configured yet/i)).toBeInTheDocument();
    });

    it('still renders nothing when a provider exists, even if read-only', () => {
      const { container } = render(
        <SharedSettingsAccessProvider readOnly canSwitch>
          <SetupRequiredBanner hasProvider={true} />
        </SharedSettingsAccessProvider>
      );

      expect(container.firstChild).toBeNull();
    });
  });
});
