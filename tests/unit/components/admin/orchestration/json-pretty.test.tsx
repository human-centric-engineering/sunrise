/**
 * JsonPretty — renders syntax-highlighted JSON.
 *
 * The component does its own regex-based tokenisation, so tests target
 * each token type (string key, string value, number, boolean, null) and
 * structural invariants (indentation preserved, max-height passthrough).
 *
 * @see components/admin/orchestration/json-pretty.tsx
 */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JsonPretty } from '@/components/admin/orchestration/json-pretty';

describe('JsonPretty', () => {
  it('renders a stringified object inside a <pre> with whitespace-pre', () => {
    const { container } = render(<JsonPretty data={{ a: 1 }} />);
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    // whitespace-pre is the load-bearing class — without it indentation
    // collapses and the syntax-highlighted view becomes unreadable.
    expect(pre?.className).toContain('whitespace-pre');
    expect(pre?.textContent).toContain('"a"');
    expect(pre?.textContent).toContain('1');
  });

  it('renders a pre-stringified JSON value as-is', () => {
    render(<JsonPretty data={'{\n  "k": 1\n}'} />);
    expect(screen.getByText(/"k"/)).toBeInTheDocument();
  });

  it('falls back to String() for un-serialisable values', () => {
    // A circular reference makes JSON.stringify throw; the component
    // catches and uses String(). The exact text doesn't matter — the
    // assertion is that the component still renders something inside a
    // <pre> without crashing.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { container } = render(<JsonPretty data={circular} />);
    expect(container.querySelector('pre')).not.toBeNull();
  });

  it('highlights string keys distinctly from string values', () => {
    const { container } = render(<JsonPretty data={{ key: 'value' }} />);
    const spans = Array.from(container.querySelectorAll('span'));
    const keySpan = spans.find((s) => s.textContent === '"key"');
    const valueSpan = spans.find((s) => s.textContent === '"value"');
    expect(keySpan).toBeDefined();
    expect(valueSpan).toBeDefined();
    // Keys and values use different colour classes — assert they're not
    // collapsed into the same span style.
    expect(keySpan?.className).not.toBe(valueSpan?.className);
  });

  it('highlights numbers, booleans, and null', () => {
    const { container } = render(<JsonPretty data={{ n: 42, b: true, f: false, x: null }} />);
    // Number 42 should be rendered inside a coloured span.
    const numSpan = Array.from(container.querySelectorAll('span')).find(
      (s) => s.textContent === '42'
    );
    expect(numSpan).toBeDefined();

    // true / false / null tokens should each land in spans.
    const tokens = ['true', 'false', 'null'];
    for (const t of tokens) {
      const span = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === t);
      expect(span, `expected a span for token "${t}"`).toBeDefined();
    }
  });

  it('passes through the className prop', () => {
    const { container } = render(<JsonPretty data={{}} className="max-h-60 overflow-y-auto" />);
    const pre = container.querySelector('pre');
    expect(pre?.className).toContain('max-h-60');
    expect(pre?.className).toContain('overflow-y-auto');
  });

  it('preserves multi-line indentation produced by JSON.stringify', () => {
    const { container } = render(<JsonPretty data={{ a: { b: 1 } }} />);
    const pre = container.querySelector('pre');
    // Two-space indent is the default for JSON.stringify(..., null, 2).
    expect(pre?.textContent).toMatch(/\n {2}"a":/);
  });

  it('handles negative numbers and scientific notation', () => {
    const { container } = render(<JsonPretty data={{ n: -1.5e-3 }} />);
    expect(container.textContent).toContain('-0.0015');
  });
});
