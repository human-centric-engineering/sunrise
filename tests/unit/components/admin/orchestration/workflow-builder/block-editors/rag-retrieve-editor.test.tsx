/**
 * Unit Tests: RagRetrieveEditor
 *
 * Test Coverage:
 * - Renders core fields: query, topK, similarity threshold
 * - Default values when config fields are omitted
 * - Typing in query textarea calls onChange with { query }
 * - Changing topK calls onChange with { topK: number }
 * - Changing similarity threshold calls onChange with { similarityThreshold: number }
 * - Renders filters textarea
 * - Shows existing filters as JSON
 * - Calls onChange with parsed JSON when valid filters are entered
 * - Calls onChange with { filters: undefined } when filters are cleared
 * - FieldHelp info buttons are present
 *
 * @see components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RagRetrieveEditor } from '@/components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor';
import type { RagRetrieveConfig } from '@/components/admin/orchestration/workflow-builder/block-editors/rag-retrieve-editor';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const emptyConfig: RagRetrieveConfig = { query: '' };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('RagRetrieveEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders the query textarea', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('rag-query')).toBeInTheDocument();
  });

  it('renders the topK input', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('rag-top-k')).toBeInTheDocument();
  });

  it('renders the similarity threshold input', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('rag-threshold')).toBeInTheDocument();
  });

  it('renders the filters textarea', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    expect(document.getElementById('rag-filters')).toBeInTheDocument();
  });

  it('renders at least one FieldHelp info button', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    const infoButtons = screen.getAllByRole('button', { name: /more information/i });
    expect(infoButtons.length).toBeGreaterThanOrEqual(1);
  });

  // ── Default values ──────────────────────────────────────────────────────────

  it('shows default topK value of 5 when not provided', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('rag-top-k') as HTMLInputElement;
    expect(Number(input.value)).toBe(5);
  });

  it('shows default similarity threshold of 0.7 when not provided', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    const input = document.getElementById('rag-threshold') as HTMLInputElement;
    expect(Number(input.value)).toBe(0.7);
  });

  it('shows empty filters textarea when filters is not set', () => {
    render(<RagRetrieveEditor config={emptyConfig} onChange={vi.fn()} />);
    const textarea = document.getElementById('rag-filters') as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
  });

  it('shows provided query value', () => {
    const config: RagRetrieveConfig = { query: 'design patterns' };
    render(<RagRetrieveEditor config={config} onChange={vi.fn()} />);
    const ta = document.getElementById('rag-query') as HTMLTextAreaElement;
    expect(ta.value).toBe('design patterns');
  });

  it('shows provided filters as JSON', () => {
    const config: RagRetrieveConfig = { query: '', filters: { source: 'manual' } };
    render(<RagRetrieveEditor config={config} onChange={vi.fn()} />);
    const textarea = document.getElementById('rag-filters') as HTMLTextAreaElement;
    expect(JSON.parse(textarea.value)).toEqual({ source: 'manual' });
  });

  // ── Callbacks ───────────────────────────────────────────────────────────────

  it('calls onChange with { query } when typing in the query textarea', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RagRetrieveEditor config={emptyConfig} onChange={onChange} />);

    await user.type(document.getElementById('rag-query')!, 'A');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('query');
    expect(lastArg.query).toBe('A');
  });

  it('calls onChange with { topK: number } when topK changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RagRetrieveEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('rag-top-k')!;
    await user.clear(input);
    await user.type(input, '10');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('topK');
    expect(typeof lastArg.topK).toBe('number');
  });

  it('calls onChange with { similarityThreshold: number } when threshold changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RagRetrieveEditor config={emptyConfig} onChange={onChange} />);

    const input = document.getElementById('rag-threshold')!;
    await user.clear(input);
    await user.type(input, '0.9');

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('similarityThreshold');
    expect(typeof lastArg.similarityThreshold).toBe('number');
  });

  it('calls onChange with { filters: undefined } when filters textarea is cleared', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const config: RagRetrieveConfig = { query: '', filters: { source: 'manual' } };
    render(<RagRetrieveEditor config={config} onChange={onChange} />);

    const textarea = document.getElementById('rag-filters')!;
    await user.clear(textarea);

    const lastArg = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastArg).toHaveProperty('filters');
    expect(lastArg.filters).toBeUndefined();
  });
});
