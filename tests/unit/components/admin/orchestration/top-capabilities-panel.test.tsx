/**
 * Unit Test: TopCapabilitiesPanel
 *
 * @see components/admin/orchestration/top-capabilities-panel.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
  TopCapabilitiesPanel,
  type CapabilityUsage,
} from '@/components/admin/orchestration/top-capabilities-panel';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeCap = (slug: string, count: number): CapabilityUsage => ({ slug, count });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TopCapabilitiesPanel', () => {
  describe('Heading', () => {
    it('renders "Top Capabilities" heading', () => {
      render(<TopCapabilitiesPanel capabilities={[]} />);

      expect(screen.getByText('Top Capabilities')).toBeInTheDocument();
    });
  });

  describe('Empty state', () => {
    it('shows "No capability usage recorded" when capabilities is an empty array', () => {
      render(<TopCapabilitiesPanel capabilities={[]} />);

      expect(screen.getByText('No capability usage recorded')).toBeInTheDocument();
    });

    it('shows "No capability usage recorded" when capabilities is null', () => {
      render(<TopCapabilitiesPanel capabilities={null} />);

      expect(screen.getByText('No capability usage recorded')).toBeInTheDocument();
    });
  });

  describe('Capability items', () => {
    it('renders capability slug and count for each item', () => {
      render(
        <TopCapabilitiesPanel
          capabilities={[makeCap('web-search', 42), makeCap('code-runner', 18)]}
        />
      );

      expect(screen.getByText('web-search')).toBeInTheDocument();
      expect(screen.getByText('42')).toBeInTheDocument();
      expect(screen.getByText('code-runner')).toBeInTheDocument();
      expect(screen.getByText('18')).toBeInTheDocument();
    });

    it('formats large counts with locale separators', () => {
      render(<TopCapabilitiesPanel capabilities={[makeCap('high-volume', 1500)]} />);

      expect(screen.getByText('1,500')).toBeInTheDocument();
    });

    it('renders a proportional width bar for each capability', () => {
      const { container } = render(
        <TopCapabilitiesPanel capabilities={[makeCap('alpha', 100), makeCap('beta', 50)]} />
      );

      // The top item should have 100% width bar; beta should be 50%
      const bars = container.querySelectorAll('.bg-primary');
      expect(bars).toHaveLength(2);

      const alphaBar = bars[0] as HTMLElement;
      const betaBar = bars[1] as HTMLElement;

      expect(alphaBar.style.width).toBe('100%');
      expect(betaBar.style.width).toBe('50%');
    });

    it('renders single capability with 100% bar width', () => {
      const { container } = render(<TopCapabilitiesPanel capabilities={[makeCap('solo', 77)]} />);

      const bar = container.querySelector('.bg-primary') as HTMLElement;
      expect(bar.style.width).toBe('100%');
    });
  });
});
