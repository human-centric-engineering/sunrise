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
});
