/**
 * MarkdownOrRawView — toggleable markdown/raw renderer.
 *
 * Verifies the two view modes render distinct DOM, the toggle is wired,
 * aria-selected mirrors state, and security-critical: raw HTML in the
 * source must not become live HTML in the rendered output.
 *
 * @see components/admin/orchestration/markdown-or-raw-view.tsx
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MarkdownOrRawView } from '@/components/admin/orchestration/markdown-or-raw-view';

describe('MarkdownOrRawView', () => {
  it('renders the Rendered tab by default with formatted output', () => {
    render(<MarkdownOrRawView content="# Heading" />);
    const renderedTab = screen.getByRole('tab', { name: /rendered/i });
    expect(renderedTab).toHaveAttribute('aria-selected', 'true');
    // The heading should land in an <h1>, not a <pre>.
    expect(screen.getByRole('heading', { level: 1, name: /heading/i })).toBeInTheDocument();
  });

  it('switches to the Raw tab on click and shows monospace content', async () => {
    const user = userEvent.setup();
    const { container } = render(<MarkdownOrRawView content="# Heading\n\nbody" />);

    await user.click(screen.getByRole('tab', { name: /raw/i }));

    const rawTab = screen.getByRole('tab', { name: /raw/i });
    expect(rawTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /rendered/i })).toHaveAttribute(
      'aria-selected',
      'false'
    );

    // Raw mode renders content inside a <pre> font-mono block.
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.className).toContain('font-mono');
    expect(pre?.textContent).toContain('# Heading');
  });

  it('applies rawMaxHeightClass only in raw mode', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MarkdownOrRawView content="some content" rawMaxHeightClass="max-h-40" />
    );

    // Rendered mode — the markdown-container div should not carry max-h-40.
    expect(container.querySelector('pre')).toBeNull();

    await user.click(screen.getByRole('tab', { name: /raw/i }));
    const pre = container.querySelector('pre');
    expect(pre?.className).toContain('max-h-40');
  });

  it('passes className through to the outer container', () => {
    const { container } = render(<MarkdownOrRawView content="text" className="custom-wrapper" />);
    expect(container.firstChild).toHaveClass('custom-wrapper');
  });

  it('renders GFM tables via the remark-gfm plugin', () => {
    const md = '| a | b |\n| - | - |\n| 1 | 2 |';
    render(<MarkdownOrRawView content={md} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    // Header and body cells.
    expect(screen.getByRole('columnheader', { name: 'a' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '1' })).toBeInTheDocument();
  });

  it('does NOT render raw HTML from the source as live HTML (XSS guard)', () => {
    // remark-gfm is parser-level; no rehype-raw plugin is enabled. A
    // <script> tag in the source must render as inert text, not execute.
    const malicious = 'before <script>window.__xss=true</script> after';
    const { container } = render(<MarkdownOrRawView content={malicious} />);
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { __xss?: boolean }).__xss).toBeUndefined();
  });

  it('keeps the toggle role=tablist for accessibility', () => {
    render(<MarkdownOrRawView content="text" />);
    const tablist = screen.getByRole('tablist', { name: /view mode/i });
    expect(tablist).toBeInTheDocument();
    expect(tablist.querySelectorAll('[role="tab"]').length).toBe(2);
  });

  it('toggles back from raw to rendered', async () => {
    const user = userEvent.setup();
    render(<MarkdownOrRawView content="# H" />);

    await user.click(screen.getByRole('tab', { name: /raw/i }));
    expect(screen.getByRole('tab', { name: /raw/i })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: /rendered/i }));
    expect(screen.getByRole('heading', { level: 1, name: /h/i })).toBeInTheDocument();
  });
});
