/**
 * Unit Tests: PatternPalette
 *
 * Test Coverage:
 * - Renders one draggable block per registry entry (9 blocks)
 * - Blocks are grouped under four category headers: Agents, Decisions, Inputs, Outputs
 * - Dragstart sets dataTransfer application/reactflow to the step type string
 * - "Learn more" links point to /admin/orchestration/learning/patterns/<patternNumber>
 *
 * @see components/admin/orchestration/workflow-builder/pattern-palette.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { PatternPalette } from '@/components/admin/orchestration/workflow-builder/pattern-palette';
import { STEP_REGISTRY } from '@/lib/orchestration/engine/step-registry';

describe('PatternPalette', () => {
  it('renders one draggable block per registry entry', () => {
    render(<PatternPalette />);

    for (const entry of STEP_REGISTRY) {
      const block = screen.getByTestId(`palette-block-${entry.type}`);
      expect(block).toBeInTheDocument();
    }
  });

  it('renders exactly 9 palette blocks (one per step type)', () => {
    render(<PatternPalette />);

    // STEP_REGISTRY has 9 entries
    expect(STEP_REGISTRY.length).toBe(9);
    const blocks = document.querySelectorAll('[data-testid^="palette-block-"]');
    expect(blocks.length).toBe(9);
  });

  it('all palette blocks have draggable attribute', () => {
    render(<PatternPalette />);

    const blocks = document.querySelectorAll('[data-testid^="palette-block-"]');
    for (const block of blocks) {
      expect(block).toHaveAttribute('draggable', 'true');
    }
  });

  describe('category headers', () => {
    it('renders an "Agents" section header', () => {
      render(<PatternPalette />);
      expect(screen.getByText('Agents')).toBeInTheDocument();
    });

    it('renders a "Decisions" section header', () => {
      render(<PatternPalette />);
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    it('renders an "Inputs" section header', () => {
      render(<PatternPalette />);
      expect(screen.getByText('Inputs')).toBeInTheDocument();
    });

    it('renders an "Outputs" section header', () => {
      render(<PatternPalette />);
      expect(screen.getByText('Outputs')).toBeInTheDocument();
    });
  });

  describe('drag-and-drop', () => {
    it('onDragStart sets application/reactflow to the step type', () => {
      render(<PatternPalette />);

      const setData = vi.fn();
      const dataTransfer = {
        setData,
        effectAllowed: '',
        getData: vi.fn(),
      };

      const block = screen.getByTestId('palette-block-llm_call');
      fireEvent.dragStart(block, { dataTransfer });

      expect(setData).toHaveBeenCalledWith('application/reactflow', 'llm_call');
    });

    it('onDragStart sets application/reactflow for every step type', () => {
      render(<PatternPalette />);

      for (const entry of STEP_REGISTRY) {
        const setData = vi.fn();
        const dataTransfer = { setData, effectAllowed: '', getData: vi.fn() };

        const block = screen.getByTestId(`palette-block-${entry.type}`);
        fireEvent.dragStart(block, { dataTransfer });

        expect(setData).toHaveBeenCalledWith('application/reactflow', entry.type);
      }
    });

    it('onDragStart accepts a dataTransfer stub without crashing', () => {
      render(<PatternPalette />);

      // happy-dom's synthetic dataTransfer doesn't support effectAllowed assignment via stub;
      // we verify that dragStart fires without error, and setData is still called.
      const setData = vi.fn();
      const dataTransfer = {
        setData,
        effectAllowed: '',
        getData: vi.fn(),
      };

      const block = screen.getByTestId('palette-block-chain');
      expect(() => fireEvent.dragStart(block, { dataTransfer })).not.toThrow();
      expect(setData).toHaveBeenCalledWith('application/reactflow', 'chain');
    });
  });

  describe('Learn more links', () => {
    it('renders a "Learn more" link for each entry that has a patternNumber', () => {
      render(<PatternPalette />);

      const entriesWithPattern = STEP_REGISTRY.filter((e) => e.patternNumber !== undefined);
      const learnMoreLinks = screen.getAllByRole('link', { name: /learn more/i });

      expect(learnMoreLinks.length).toBe(entriesWithPattern.length);
    });

    it('Learn more link for llm_call points to /admin/orchestration/learning/patterns/1', () => {
      render(<PatternPalette />);

      // Find the one inside the llm_call block
      const llmBlock = screen.getByTestId('palette-block-llm_call');
      const learnMoreLink = llmBlock.querySelector('a');

      expect(learnMoreLink).toHaveAttribute('href', '/admin/orchestration/learning/patterns/1');
    });

    it('Learn more links have correct pattern numbers for all entries', () => {
      render(<PatternPalette />);

      for (const entry of STEP_REGISTRY) {
        if (!entry.patternNumber) continue;

        const block = screen.getByTestId(`palette-block-${entry.type}`);
        const link = block.querySelector('a');

        expect(link).toHaveAttribute(
          'href',
          `/admin/orchestration/learning/patterns/${entry.patternNumber}`
        );
      }
    });
  });
});
