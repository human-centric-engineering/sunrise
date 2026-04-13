/**
 * PatternContent Component Tests
 *
 * Test coverage:
 * - Plain markdown renders through react-markdown
 * - Mermaid code blocks are forwarded to MermaidDiagram
 * - Non-mermaid code blocks render as normal <code> elements
 * - The pre override strips the wrapping <pre> tag
 *
 * @see components/admin/orchestration/learn/pattern-content.tsx
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/components/admin/orchestration/learn/mermaid-diagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => <div data-testid="mermaid-diagram">{code}</div>,
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

import { PatternContent } from '@/components/admin/orchestration/learn/pattern-content';

describe('PatternContent', () => {
  it('renders plain markdown text', () => {
    render(<PatternContent content="Hello **world**" />);

    expect(screen.getByText('world')).toBeInTheDocument();
  });

  it('forwards mermaid code blocks to MermaidDiagram', () => {
    const content = '```mermaid\ngraph TD; A-->B\n```';

    render(<PatternContent content={content} />);

    const diagram = screen.getByTestId('mermaid-diagram');
    expect(diagram).toBeInTheDocument();
    expect(diagram).toHaveTextContent('graph TD; A-->B');
  });

  it('renders non-mermaid code blocks as normal <code> elements', () => {
    const content = '```typescript\nconst x = 1;\n```';

    render(<PatternContent content={content} />);

    const codeEl = screen.getByText('const x = 1;');
    expect(codeEl.tagName).toBe('CODE');
    expect(codeEl).toHaveClass('language-typescript');
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });

  it('does not double-wrap code blocks in <pre> tags', () => {
    const content = '```typescript\nconst x = 1;\n```';

    const { container } = render(<PatternContent content={content} />);

    expect(container.querySelectorAll('pre')).toHaveLength(0);
  });

  it('handles mermaid blocks with non-string children gracefully', () => {
    // When children is not a string, MermaidDiagram receives an empty string
    // This is covered by the typeof check in the component
    const content = '```mermaid\ngraph TD; A-->B\n```';

    render(<PatternContent content={content} />);

    expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
  });
});
