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

// DOMPurify is called by the source to sanitize mermaid SVG output before DOM
// injection. Mocking it lets tests control what reaches the DOM and verify the
// correct options are passed.
const mockSanitize = vi.fn();

vi.mock('dompurify', () => ({
  default: {
    sanitize: mockSanitize,
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

import { MermaidDiagram } from '@/components/admin/orchestration/learn/mermaid-diagram';

describe('MermaidDiagram', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: sanitize passes SVG through unchanged.
    mockSanitize.mockImplementation((input: string) => input);
  });

  it('renders the diagram wrapper into the document before async render resolves', async () => {
    // Keep the render pending so we can observe the pre-resolve state,
    // then resolve it so the effect cleans up before the next test.
    let resolveRender!: (value: { svg: string }) => void;
    mockRender.mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve;
      })
    );

    const { container } = render(<MermaidDiagram code="graph TD; A-->B" />);

    // The outer wrapper div with class "my-4" must be present immediately —
    // before the async mermaid render even resolves.
    expect(container.querySelector('.my-4')).toBeInTheDocument();

    // Resolve the pending render so the effect completes before the next test.
    resolveRender({ svg: '<svg></svg>' });
    await waitFor(() => {
      expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument();
    });
  });

  it('injects sanitized SVG into the container after mermaid renders', async () => {
    const rawSvg = '<svg class="mermaid-output"></svg>';
    mockRender.mockResolvedValue({ svg: rawSvg });
    // Sanitize passes SVG through unchanged (default behaviour — no dangerous content).
    mockSanitize.mockImplementation((input: string) => input);

    const { container } = render(<MermaidDiagram code="graph TD; A-->B" />);

    await waitFor(() => {
      const svg = container.querySelector('svg');
      expect(svg).toBeInTheDocument();
    });

    // Verify DOMPurify.sanitize was called with the raw SVG and the correct
    // options — the source must use svg profile, not just pass through raw HTML.
    expect(mockSanitize).toHaveBeenCalledWith(rawSvg, { USE_PROFILES: { svg: true } });
  });

  it('leaves the diagram container empty when DOMPurify strips all SVG content', async () => {
    // Simulate DOMPurify removing all content (e.g. XSS payload disguised as SVG).
    const rawSvg = '<svg><script>alert(1)</script></svg>';
    mockRender.mockResolvedValue({ svg: rawSvg });
    mockSanitize.mockReturnValue('');

    const { container } = render(<MermaidDiagram code="graph TD; A-->B" />);

    await waitFor(() => {
      // Loading skeleton must disappear — the render did complete.
      expect(container.querySelector('.animate-pulse')).not.toBeInTheDocument();
    });

    // No SVG should reach the DOM when sanitize strips the content.
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    // The error fallback must NOT appear — this is a silent strip, not an error.
    expect(screen.queryByText(/could not be rendered/i)).not.toBeInTheDocument();
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

    // Loading skeleton should be visible before the async render resolves.
    const skeleton = container.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();

    // Resolve and wait for SVG.
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

    // Track the total initialize calls before this test.
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
    // (it may be 0 if a prior test already triggered the guard).
    const initCallsDuring = mockInitialize.mock.calls.length - initCallsBefore;
    expect(initCallsDuring).toBeLessThanOrEqual(1);
  });
});
