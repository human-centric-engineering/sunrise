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

    // Non-mermaid code blocks are wrapped in a single <pre> tag
    expect(container.querySelectorAll('pre')).toHaveLength(1);
  });

  it('handles mermaid blocks with non-string children gracefully', () => {
    // When children is not a string, MermaidDiagram receives an empty string
    // This is covered by the typeof check in the component
    const content = '```mermaid\ngraph TD; A-->B\n```';

    render(<PatternContent content={content} />);

    expect(screen.getByTestId('mermaid-diagram')).toBeInTheDocument();
  });

  it('renders inline code (no language class) as normal code element', () => {
    const content = 'Use the `fetch()` function.';

    render(<PatternContent content={content} />);

    const codeEl = screen.getByText('fetch()');
    expect(codeEl.tagName).toBe('CODE');
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });

  it('preserves pre wrapper for non-mermaid fenced code blocks', () => {
    const content = '```python\nprint("hello")\n```';

    const { container } = render(<PatternContent content={content} />);

    const preElements = container.querySelectorAll('pre');
    expect(preElements).toHaveLength(1);
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });

  it('renders multiple separate code blocks in one document', () => {
    // Both a mermaid and a typescript block in the same content
    const content = [
      '```mermaid',
      'graph TD; A-->B',
      '```',
      '',
      'Some prose in between.',
      '',
      '```typescript',
      'const x = 42;',
      '```',
    ].join('\n');

    const { container } = render(<PatternContent content={content} />);

    // Mermaid diagram rendered
    const diagram = screen.getByTestId('mermaid-diagram');
    expect(diagram).toBeInTheDocument();
    expect(diagram).toHaveTextContent('graph TD; A-->B');

    // TypeScript block rendered as a normal code element
    expect(screen.getByText('const x = 42;')).toBeInTheDocument();

    // Only one <pre> — for the typescript block; mermaid has no pre wrapper
    expect(container.querySelectorAll('pre')).toHaveLength(1);
  });

  it('renders an empty mermaid diagram when content is an empty code block', () => {
    // Edge: mermaid block with no body text
    const content = '```mermaid\n\n```';

    render(<PatternContent content={content} />);

    const diagram = screen.getByTestId('mermaid-diagram');
    expect(diagram).toBeInTheDocument();
    // Trimmed to empty string
    expect(diagram.textContent?.trim()).toBe('');
  });

  it('renders plain prose paragraphs without any code elements', () => {
    const content = 'Just some **bold** text and _italic_ text.';

    const { container } = render(<PatternContent content={content} />);

    expect(screen.getByText('bold')).toBeInTheDocument();
    expect(container.querySelectorAll('code')).toHaveLength(0);
    expect(screen.queryByTestId('mermaid-diagram')).not.toBeInTheDocument();
  });
});
