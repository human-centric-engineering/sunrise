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

import {
  ReferenceLink,
  shortenReference,
  SourceTooltipBody,
  SourcesField,
  tryStringify,
} from '@/components/admin/orchestration/approvals/sources-field';
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

  it('stacks pills vertically when layout="stack" (trace-viewer mode)', () => {
    const value: ProvenanceItem[] = [
      { source: 'web_search', confidence: 'high', reference: 'https://example.com' },
      { source: 'training_knowledge', confidence: 'low' },
    ];
    const { container } = render(<SourcesField value={value} layout="stack" />);
    // The wrapper div carries flex-col in stack mode and flex-wrap in inline mode.
    const wrapper = container.querySelector('.flex-col');
    expect(wrapper).not.toBeNull();
  });
});

describe('SourceTooltipBody', () => {
  it('renders source label, confidence, reference, snippet, and note when all are present', () => {
    const item: ProvenanceItem = {
      source: 'web_search',
      confidence: 'high',
      reference: 'https://example.com/article',
      snippet: 'Qwen2.5 series is a general-purpose chat LLM.',
      note: 'Official release notes',
    };

    render(<SourceTooltipBody item={item} description="Sourced from a web search result" />);

    // The phrase "web search" appears in both the label (replacing the
    // underscore in "web_search") and the description ("Sourced from a
    // web search result") — assert at least one match rather than a
    // unique one.
    expect(screen.getAllByText(/web search/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/high confidence/i)).toBeInTheDocument();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.getByText('Snippet')).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.getByText(item.snippet!)).toBeInTheDocument();
    expect(screen.getByText(item.note!)).toBeInTheDocument();
  });

  it('omits optional sections when reference / snippet / note are absent', () => {
    const item: ProvenanceItem = {
      source: 'training_knowledge',
      confidence: 'low',
    };

    render(<SourceTooltipBody item={item} description="Training knowledge" />);

    expect(screen.queryByText('Reference')).not.toBeInTheDocument();
    expect(screen.queryByText('Snippet')).not.toBeInTheDocument();
    expect(screen.queryByText('Note')).not.toBeInTheDocument();
  });

  it('replaces underscores with spaces in the source label', () => {
    const item: ProvenanceItem = {
      source: 'knowledge_base',
      confidence: 'high',
      reference: 'chunk-abc',
    };

    render(<SourceTooltipBody item={item} description="KB" />);

    expect(screen.getByText('knowledge base')).toBeInTheDocument();
  });
});

describe('ReferenceLink', () => {
  it('renders an anchor with target="_blank" for URL references', () => {
    render(<ReferenceLink reference="https://example.com/path" />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/path');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('renders a plain paragraph for non-URL references', () => {
    render(<ReferenceLink reference="chunk-abc-123" />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('chunk-abc-123')).toBeInTheDocument();
  });

  it('prefixes the reference with stepId when stepId is provided and reference is not a URL', () => {
    render(<ReferenceLink reference="output.models[0].slug" stepId="load_models" />);

    expect(screen.getByText('load_models · output.models[0].slug')).toBeInTheDocument();
  });

  it('ignores stepId for URL references (URLs are self-locating)', () => {
    render(<ReferenceLink reference="https://example.com" stepId="load_models" />);

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com');
    // stepId not rendered alongside a URL — the URL identifies itself.
    expect(screen.queryByText(/load_models · /)).not.toBeInTheDocument();
  });
});

describe('shortenReference', () => {
  it('returns null for undefined', () => {
    expect(shortenReference(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(shortenReference('')).toBeNull();
  });

  it('returns the hostname (without www) for a URL', () => {
    expect(shortenReference('https://www.example.com/path')).toBe('example.com');
    expect(shortenReference('https://api.brave.com/v1/search')).toBe('api.brave.com');
  });

  it('returns short non-URL references unchanged', () => {
    expect(shortenReference('chunk-1')).toBe('chunk-1');
  });

  it('head-truncates non-URL references over 24 characters', () => {
    const long = 'output.models[3].providerSlug.value';
    const result = shortenReference(long);
    expect(result?.length).toBeLessThanOrEqual(24);
    expect(result?.endsWith('…')).toBe(true);
  });

  it('falls back to truncation when URL parsing throws', () => {
    // A string that looks URL-ish but fails URL parsing — covers the try/catch fallback.
    const malformed = 'https://[invalid-url-structure-too-long-to-fit';
    const result = shortenReference(malformed);
    expect(result).not.toBeNull();
    expect(result?.length).toBeLessThanOrEqual(24);
  });
});

describe('tryStringify', () => {
  it('serialises plain objects', () => {
    expect(tryStringify({ a: 1, b: 'two' })).toContain('"a": 1');
  });

  it('returns "[unserializable]" for circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(tryStringify(circular)).toBe('[unserializable]');
  });
});
