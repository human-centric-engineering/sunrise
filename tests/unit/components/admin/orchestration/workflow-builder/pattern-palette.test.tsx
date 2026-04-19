/**
 * Unit Tests: PatternPalette
 *
 * Test Coverage:
 * - Renders one draggable block per registry entry (9 blocks)
 * - Blocks are grouped under four category headers: Agents, Decisions, Inputs, Outputs
 * - Dragstart sets dataTransfer application/reactflow to the step type string
 * - "Learn more" links point to /admin/orchestration/learning/patterns/<patternNumber>
 * - Info button renders next to the "Patterns" heading
 * - Clicking the Info button opens PatternCoverageDialog with title "Pattern Coverage"
 * - PatternCoverageDialog is not visible before the Info button is clicked
 *
 * @see components/admin/orchestration/workflow-builder/pattern-palette.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

  it('renders exactly 13 palette blocks (one per step type)', () => {
    render(<PatternPalette />);

    // STEP_REGISTRY has 13 entries
    expect(STEP_REGISTRY.length).toBe(13);
    const blocks = document.querySelectorAll('[data-testid^="palette-block-"]');
    expect(blocks.length).toBe(13);
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

  describe('Learn more buttons', () => {
    it('renders a "Learn more" button for each entry that has a patternNumber', () => {
      render(<PatternPalette />);

      const entriesWithPattern = STEP_REGISTRY.filter((e) => e.patternNumber !== undefined);
      const learnMoreButtons = screen.getAllByRole('button', { name: /learn more/i });

      expect(learnMoreButtons.length).toBe(entriesWithPattern.length);
    });

    it('each entry with a patternNumber has a Learn more button in its block', () => {
      render(<PatternPalette />);

      for (const entry of STEP_REGISTRY) {
        if (!entry.patternNumber) continue;

        const block = screen.getByTestId(`palette-block-${entry.type}`);
        const button = block.querySelector('button');

        expect(button).not.toBeNull();
        expect(button?.textContent).toMatch(/learn more/i);
      }
    });

    it('each step type maps to the correct design pattern number', () => {
      // Canonical mapping: step type → knowledge base pattern number.
      // If this test fails, someone changed a patternNumber in the
      // registry without verifying it still points to the right pattern.
      const expectedMapping: Record<string, number> = {
        llm_call: 1, // Prompt Chaining
        chain: 1, // Prompt Chaining
        route: 2, // Routing
        parallel: 3, // Parallelisation
        reflect: 4, // Reflection
        tool_call: 5, // Tool Use
        plan: 6, // Planning
        human_approval: 13, // Human-in-the-Loop
        rag_retrieve: 14, // Knowledge Retrieval (RAG)
        guard: 18, // Guardrails & Safety
        evaluate: 19, // Evaluation & Monitoring
        external_call: 15, // Inter-Agent Communication (A2A)
        agent_call: 8, // Orchestrator-Workers
      };

      for (const entry of STEP_REGISTRY) {
        if (entry.patternNumber === undefined) continue;
        expect(
          entry.patternNumber,
          `${entry.type} should link to pattern ${expectedMapping[entry.type]}`
        ).toBe(expectedMapping[entry.type]);
      }
    });
  });

  describe('Info button and PatternCoverageDialog', () => {
    it('renders the Info button next to the "Patterns" heading', () => {
      render(<PatternPalette />);

      // Arrange: palette is rendered
      // Act/Assert: the ghost icon button with the tooltip title is present
      const infoButton = screen.getByRole('button', {
        name: /how patterns map to step types/i,
      });

      expect(infoButton).toBeInTheDocument();
    });

    it('PatternCoverageDialog is not visible before the Info button is clicked', () => {
      render(<PatternPalette />);

      // The dialog title should not be in the DOM when coverageOpen is false
      expect(screen.queryByText('Pattern Coverage')).not.toBeInTheDocument();
    });

    it('clicking the Info button opens PatternCoverageDialog with title "Pattern Coverage"', async () => {
      const user = userEvent.setup();
      render(<PatternPalette />);

      // Arrange: locate the Info button
      const infoButton = screen.getByRole('button', {
        name: /how patterns map to step types/i,
      });

      // Act: click the Info button to set coverageOpen to true
      await user.click(infoButton);

      // Assert: the dialog title is now visible
      expect(screen.getByText('Pattern Coverage')).toBeInTheDocument();
    });
  });
});
