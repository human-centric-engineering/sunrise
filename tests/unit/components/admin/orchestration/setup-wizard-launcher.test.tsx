/**
 * SetupWizardLauncher Component Tests
 *
 * Test Coverage:
 * - Renders "Setup Guide" trigger button
 * - SetupWizard is not mounted before the button is clicked
 * - Clicking the button mounts and opens SetupWizard
 * - SetupWizard receives open=true after click
 * - Closing the wizard via onOpenChange(false) unmounts the wizard
 *
 * @see components/admin/orchestration/setup-wizard-launcher.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SetupWizardLauncher } from '@/components/admin/orchestration/setup-wizard-launcher';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  })),
  usePathname: vi.fn(() => '/admin/orchestration'),
}));

// Mock SetupWizard so tests don't need to deal with its complex internal state
// (localStorage, SSE chat, multi-step form, etc.). We capture the onOpenChange
// prop so tests can simulate the wizard closing itself.
let capturedOnOpenChange: ((open: boolean) => void) | null = null;

vi.mock('@/components/admin/orchestration/setup-wizard', () => ({
  SetupWizard: ({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) => {
    capturedOnOpenChange = onOpenChange;
    return open ? <div data-testid="setup-wizard" /> : null;
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SetupWizardLauncher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnOpenChange = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Trigger button ────────────────────────────────────────────────────────

  describe('trigger button', () => {
    it('renders the "Setup Guide" button', () => {
      render(<SetupWizardLauncher />);

      expect(screen.getByRole('button', { name: /setup guide/i })).toBeInTheDocument();
    });

    it('does not render SetupWizard before the button is clicked', () => {
      render(<SetupWizardLauncher />);

      expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument();
    });
  });

  // ── Opening the wizard ────────────────────────────────────────────────────

  describe('opening the wizard', () => {
    it('mounts and shows SetupWizard after clicking Setup Guide', async () => {
      const user = userEvent.setup();
      render(<SetupWizardLauncher />);

      await user.click(screen.getByRole('button', { name: /setup guide/i }));

      expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
    });

    it('passes open=true to SetupWizard after clicking Setup Guide', async () => {
      const user = userEvent.setup();
      render(<SetupWizardLauncher />);

      await user.click(screen.getByRole('button', { name: /setup guide/i }));

      // The mock only renders the div when open=true, so its presence confirms open=true
      expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();
    });
  });

  // ── Closing the wizard ────────────────────────────────────────────────────

  describe('closing the wizard', () => {
    it('unmounts SetupWizard when onOpenChange(false) is called', async () => {
      const user = userEvent.setup();
      render(<SetupWizardLauncher />);

      // Open the wizard
      await user.click(screen.getByRole('button', { name: /setup guide/i }));
      expect(screen.getByTestId('setup-wizard')).toBeInTheDocument();

      // Simulate the wizard closing itself (e.g. user presses Escape or clicks X).
      // Must be wrapped in act() because it triggers a React state update directly.
      act(() => {
        capturedOnOpenChange!(false);
      });

      expect(screen.queryByTestId('setup-wizard')).not.toBeInTheDocument();
    });
  });
});
