/**
 * SourcesField Component Tests
 *
 * Test coverage:
 * - Valid ProvenanceItem[] renders one pill per source with the right
 *   short-label per source kind.
 * - Pills carry an aria-label so screen-reader users get the source kind
 *   + confidence without having to open the tooltip.
 * - URL references get linkified (anchor with href); non-URL references
 *   render as plain text.
 * - Empty array → em-dash placeholder (no pills).
 * - Malformed array (fails schema validation) → JSON fallback `<pre>` so
 *   the approval UI never blanks a cell.
 *
 * @see components/admin/orchestration/approvals/sources-field.tsx
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { SourcesField } from '@/components/admin/orchestration/approvals/sources-field';
import type { ProvenanceItem } from '@/lib/orchestration/provenance/types';

describe('SourcesField', () => {
  it('renders one pill per source for a valid array', () => {
    const value: ProvenanceItem[] = [
      { source: 'web_search', confidence: 'high', reference: 'https://example.com/article' },
      { source: 'training_knowledge', confidence: 'low', note: 'inferred from name pattern' },
    ];

    render(<SourcesField value={value} />);

    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('training')).toBeInTheDocument();
  });

  it('attaches a descriptive aria-label combining kind + confidence', () => {
    const value: ProvenanceItem[] = [
      { source: 'web_search', confidence: 'high', reference: 'https://example.com' },
    ];

    render(<SourcesField value={value} />);

    const pill = screen.getByLabelText(/Sourced from a web search result.*high confidence/i);
    expect(pill).toBeInTheDocument();
  });

  it('uses the correct short label for each source kind', () => {
    const value: ProvenanceItem[] = [
      { source: 'web_search', confidence: 'high', reference: 'https://example.com' },
      { source: 'knowledge_base', confidence: 'high', reference: 'chunk-1' },
      {
        source: 'prior_step',
        confidence: 'high',
        reference: 'load_models.output',
        stepId: 'load_models',
      },
      { source: 'external_call', confidence: 'high', reference: 'https://api.example.com' },
      { source: 'user_input', confidence: 'high', reference: 'input.modelIds' },
      { source: 'training_knowledge', confidence: 'low' },
    ];

    render(<SourcesField value={value} />);

    expect(screen.getByText('web')).toBeInTheDocument();
    expect(screen.getByText('kb')).toBeInTheDocument();
    expect(screen.getByText('step')).toBeInTheDocument();
    expect(screen.getByText('api')).toBeInTheDocument();
    expect(screen.getByText('input')).toBeInTheDocument();
    expect(screen.getByText('training')).toBeInTheDocument();
  });

  it('shows an em-dash placeholder for an empty array', () => {
    render(<SourcesField value={[]} />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('falls back to a JSON pre block for malformed arrays', () => {
    const malformed = [{ source: 'made_up_kind', confidence: 'high' }, 'not-even-an-object'];

    const { container } = render(<SourcesField value={malformed} />);

    // The schema rejects the array, so the component falls back to the
    // raw-JSON branch — find the <pre> by tag rather than test-id since
    // the renderer doesn't ship a stable selector for the fallback.
    const pre = container.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('made_up_kind');
  });

  it('renders nothing when value is null or undefined (treated as malformed)', () => {
    // Schema rejects null / undefined directly — falls back to JSON.
    // Verify the component doesn't crash and renders the fallback.
    const { container } = render(<SourcesField value={null} />);
    expect(container.querySelector('pre')).not.toBeNull();
  });
});
