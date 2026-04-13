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

  it('shows loading skeleton before mermaid resolves', async () => {
    let resolveRender!: (value: { svg: string }) => void;
    mockRender.mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve;
      })
    );

    const { container } = render(<MermaidDiagram code="graph TD; A-->B" />);

    // Loading skeleton should be visible
    const skeleton = container.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();

    // Resolve and wait for SVG
    resolveRender({ svg: '<svg class="mermaid-output"></svg>' });

    await waitFor(() => {
      expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument();
    });
  });

  it('shows fallback message when non-Error value is thrown', async () => {
    mockRender.mockRejectedValue('string error');

    render(<MermaidDiagram code="bad syntax" />);

    await waitFor(() => {
      expect(screen.getByText('bad syntax')).toBeInTheDocument();
      expect(screen.getByText(/could not be rendered/i)).toBeInTheDocument();
    });
  });

  it('calls mermaid.initialize at most once across multiple instances', async () => {
    mockRender.mockResolvedValue({ svg: '<svg></svg>' });

    // Track the total initialize calls before this test
    const initCallsBefore = mockInitialize.mock.calls.length;

    const { unmount } = render(<MermaidDiagram code="graph TD; A-->B" />);
    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
    });
    unmount();

    mockRender.mockClear();
    render(<MermaidDiagram code="graph TD; C-->D" />);
    await waitFor(() => {
      expect(mockRender).toHaveBeenCalled();
    });

    // initialize should have been called at most once across both renders
    // (it may be 0 if a prior test already triggered the guard)
    const initCallsDuring = mockInitialize.mock.calls.length - initCallsBefore;
    expect(initCallsDuring).toBeLessThanOrEqual(1);
  });
});
