/**
 * MermaidDiagram Component Tests
 *
 * @see components/admin/orchestration/learn/mermaid-diagram.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRender = vi.fn();
const mockInitialize = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: mockInitialize,
    render: mockRender,
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

import { MermaidDiagram } from '@/components/admin/orchestration/learn/mermaid-diagram';

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the diagram container', () => {
    mockRender.mockResolvedValue({ svg: '<svg data-testid="mermaid-svg"></svg>' });

    const { container } = render(<MermaidDiagram code="graph TD; A-->B" />);

    expect(container).toBeTruthy();
  });

  it('renders SVG after mermaid processes the code', async () => {
    mockRender.mockResolvedValue({ svg: '<svg class="mermaid-output"></svg>' });

    const { container } = render(<MermaidDiagram code="graph TD; A-->B" />);

    await waitFor(() => {
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });
  });

  it('shows fallback code block on render error', async () => {
    mockRender.mockRejectedValue(new Error('Parse error'));

    render(<MermaidDiagram code="invalid mermaid syntax" />);

    await waitFor(() => {
      expect(screen.getByText('invalid mermaid syntax')).toBeInTheDocument();
      expect(screen.getByText(/could not be rendered/i)).toBeInTheDocument();
    });
  });
});
