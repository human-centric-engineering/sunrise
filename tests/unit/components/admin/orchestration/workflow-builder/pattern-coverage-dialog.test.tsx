/**
 * Unit Tests: PatternCoverageDialog
 *
 * Test Coverage:
 * - Renders dialog title when open=true
 * - All 3 tier headings (Foundation, Intermediate, Advanced) are visible
 * - All 21 patterns render (verified by #N markers)
 * - Exactly 3 "Gap" badges are present (patterns #18, #15, #19)
 * - Amber footer callout mentions "3 patterns" and the 3 gap names
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

  // ─── Tier Headings ───────────────────────────────────────────────────────────

  it('renders all 3 tier headings', () => {
    render(<PatternCoverageDialog {...defaultProps} />);

    expect(screen.getByText('Foundation')).toBeInTheDocument();
    expect(screen.getByText('Intermediate')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
  });

  // ─── All 21 Patterns ─────────────────────────────────────────────────────────

  it('renders all 21 pattern number markers (#1 – #21)', () => {
    render(<PatternCoverageDialog {...defaultProps} />);

    // The component renders patterns 1–21 (not all consecutive — uses numbers from
    // PATTERN_MAPPINGS: 1,2,5,14,18,3,4,6,7,8,13,9,10,11,12,15,16,17,19,20,21)
    const expectedNumbers = [
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
    ];
    for (const num of expectedNumbers) {
      expect(screen.getByText(`#${num}`)).toBeInTheDocument();
    }
  });

  // ─── Gap Badges ──────────────────────────────────────────────────────────────

  it('renders exactly 3 "Gap" badges for the three gap patterns', () => {
    render(<PatternCoverageDialog {...defaultProps} />);

    const gapBadges = screen.getAllByText('Gap');
    expect(gapBadges).toHaveLength(3);
  });

  // ─── Amber Footer Callout ────────────────────────────────────────────────────

  it('amber footer callout mentions "3 patterns" and all three gap pattern names', () => {
    render(<PatternCoverageDialog {...defaultProps} />);

    // The footer paragraph contains the canonical gap description
    const callout = screen.getByText(/3 patterns are flagged as gaps/i);
    expect(callout).toBeInTheDocument();
    expect(callout.textContent).toMatch(/Guardrails/);
    expect(callout.textContent).toMatch(/Inter-Agent Communication/);
    expect(callout.textContent).toMatch(/Evaluation/);
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
