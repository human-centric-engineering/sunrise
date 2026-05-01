/**
 * Unit Tests: PatternCoverageDialog
 *
 * Test Coverage:
 * - Renders dialog title when open=true
 * - All 21 patterns render (verified by #N markers)
 * - No "Gap" badges are present (all patterns covered or engine-level)
 * - Emerald footer callout confirms all 21 patterns are covered
 * - Clicking Close calls onOpenChange(false)
 * - Dialog content is absent when open=false
 *
 * @see components/admin/orchestration/workflow-builder/pattern-coverage-dialog.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PatternCoverageDialog } from '@/components/admin/orchestration/workflow-builder/pattern-coverage-dialog';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PatternCoverageDialog', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Visibility ─────────────────────────────────────────────────────────────

  it('renders dialog title "Pattern Coverage" when open=true', () => {
    render(<PatternCoverageDialog {...defaultProps} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Pattern Coverage')).toBeInTheDocument();
  });

  it('does not render dialog content when open=false', () => {
    render(<PatternCoverageDialog {...defaultProps} open={false} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('Pattern Coverage')).not.toBeInTheDocument();
  });

  // ─── All 21 Patterns ─────────────────────────────────────────────────────────

  it('renders all 21 pattern number markers (#1 – #21)', () => {
    render(<PatternCoverageDialog {...defaultProps} />);

    const expectedNumbers = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ];
    for (const num of expectedNumbers) {
      expect(screen.getByText(`#${num}`)).toBeInTheDocument();
    }
  });

  // ─── No Gaps ─────────────────────────────────────────────────────────────────

  it('renders no "Gap" badges — all patterns are covered or engine-level', () => {
    render(<PatternCoverageDialog {...defaultProps} />);

    expect(screen.queryAllByText('Gap')).toHaveLength(0);
  });

  // ─── Emerald Footer Callout ─────────────────────────────────────────────────

  it('footer callout confirms all 21 patterns are covered', () => {
    render(<PatternCoverageDialog {...defaultProps} />);

    const callout = screen.getByText(/all 21 design patterns are covered/i);
    expect(callout).toBeInTheDocument();
  });

  // ─── Close Button ────────────────────────────────────────────────────────────

  it('calls onOpenChange(false) when the Close button is clicked', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<PatternCoverageDialog open={true} onOpenChange={onOpenChange} />);

    // The dialog footer has an outline Button whose visible text is "Close".
    // The Radix Dialog also injects an icon-only X button with sr-only "Close" text,
    // so we target the footer button via its exact visible text using getAllByRole and
    // picking the one that is NOT the icon-only button (i.e. not aria-hidden svg variant).
    const closeButtons = screen.getAllByRole('button', { name: /^close$/i });
    // The footer button has no SVG child — it renders plain text "Close"
    const footerClose = closeButtons.find((btn) => btn.querySelector('svg') === null);
    expect(footerClose).toBeDefined();
    await user.click(footerClose!);

    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
