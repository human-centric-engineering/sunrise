// @vitest-environment happy-dom

/**
 * MessageWithCitations Component Tests
 *
 * Verifies the marker → superscript expansion and the sources panel
 * rendering. Plain content (no markers, no citations) renders as a
 * single text run; valid markers become anchors keyed to citation IDs;
 * markers without a matching citation get the "hallucinated" treatment.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  CitationsList,
  MessageWithCitations,
  formatSourcesLabel,
  getCitedMarkers,
  relevancePercent,
  topRelevancePercent,
} from '@/components/admin/orchestration/chat/message-with-citations';
import type { Citation } from '@/types/orchestration';

function makeCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    marker: 1,
    chunkId: 'c1',
    documentId: 'd1',
    documentName: 'Tenancy Guide',
    contentHash: null,
    documentVersion: null,
    section: 'Page 12',
    patternNumber: null,
    patternName: null,
    excerpt: 'The deposit must be protected within 30 days.',
    similarity: 0.9,
    ...overrides,
  };
}

describe('MessageWithCitations', () => {
  it('renders plain content unchanged when no citations are provided', () => {
    render(<MessageWithCitations content="Hello world." />);
    expect(screen.getByText('Hello world.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();
  });

  it('replaces [N] markers with linked superscript references', () => {
    const citations = [makeCitation({ marker: 1 }), makeCitation({ marker: 2, chunkId: 'c2' })];
    render(<MessageWithCitations content="Foo [1] bar [2] baz." citations={citations} />);
    const link1 = screen.getByLabelText('Citation 1');
    const link2 = screen.getByLabelText('Citation 2');
    expect(link1).toHaveAttribute('href', '#citation-1');
    expect(link2).toHaveAttribute('href', '#citation-2');
  });

  it('renders the citations panel with one entry per citation', async () => {
    const user = userEvent.setup();
    const citations = [
      makeCitation({ marker: 1, documentName: 'Tenancy Guide', section: 'Page 12' }),
      makeCitation({
        marker: 2,
        documentName: 'Renters Reform Act',
        section: 'Section 21',
        excerpt: 'Notice must give two months.',
      }),
    ];
    render(<MessageWithCitations content="Foo [1] [2]" citations={citations} />);
    // Sources panel is collapsed by default — expand it to inspect rows.
    expect(screen.getByText('Sources (2 used of 2)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /sources \(2 used of 2\)/i }));
    expect(screen.getByText('Tenancy Guide')).toBeInTheDocument();
    expect(screen.getByText('Renters Reform Act')).toBeInTheDocument();
    expect(screen.getByText(/Notice must give two months/)).toBeInTheDocument();
  });

  it('marks markers without a matching citation as hallucinated', () => {
    const citations = [makeCitation({ marker: 1 })];
    render(<MessageWithCitations content="See [1] and [3]." citations={citations} />);
    const bad = screen.getByLabelText('Unmatched citation marker 3');
    expect(bad).toBeInTheDocument();
    expect(bad).toHaveAttribute('title', expect.stringContaining('hallucinated') as unknown);
  });

  it('falls back to patternName when documentName is missing', async () => {
    const user = userEvent.setup();
    const citations = [
      makeCitation({
        documentName: null,
        patternName: 'ReAct',
      }),
    ];
    render(<MessageWithCitations content="See [1]" citations={citations} />);
    await user.click(screen.getByRole('button', { name: /sources \(1 used of 1\)/i }));
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('toggles the sources panel when the heading button is clicked', async () => {
    const user = userEvent.setup();
    render(<MessageWithCitations content="See [1]" citations={[makeCitation()]} />);
    const toggle = screen.getByRole('button', { name: /sources \(1 used of 1\)/i });
    // Panel starts collapsed — the body of the message is the primary
    // content; sources expand on demand.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('omits the section span when section is null', async () => {
    const user = userEvent.setup();
    const citations = [makeCitation({ section: null })];
    render(<MessageWithCitations content="See [1]" citations={citations} />);
    await user.click(screen.getByRole('button', { name: /sources \(1 used of 1\)/i }));
    const list = screen.getByRole('list');
    expect(within(list).queryByText(/·/)).not.toBeInTheDocument();
  });

  it('reveals a collapsed sources panel when a valid marker is clicked', async () => {
    const user = userEvent.setup();
    render(<MessageWithCitations content="See [1]" citations={[makeCitation({ marker: 1 })]} />);
    const toggle = screen.getByRole('button', { name: /sources \(1 used of 1\)/i });
    // Panel is collapsed by default; clicking a citation marker should
    // expand it so the target row is visible.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(screen.getByLabelText('Citation 1'));
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('prevents navigation when a hallucinated marker is clicked', () => {
    render(<MessageWithCitations content="See [9]" citations={[makeCitation({ marker: 1 })]} />);
    const link = screen.getByLabelText('Unmatched citation marker 9');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    // React's synthetic preventDefault propagates to the native event.
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves bracketed digits alone when there are no citations on the turn', () => {
    // A non-RAG response that happens to mention `[5]` must not be
    // treated as a hallucinated marker — there is no envelope to
    // validate against, so substitution is wrong.
    render(<MessageWithCitations content="See paragraph [5] of the manual." />);
    expect(screen.queryByLabelText(/citation/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Unmatched citation marker/)).not.toBeInTheDocument();
    expect(screen.getByText('See paragraph [5] of the manual.')).toBeInTheDocument();
  });

  it('renders adjacent markers as separate references', () => {
    const citations = [makeCitation({ marker: 1 }), makeCitation({ marker: 2, chunkId: 'c2' })];
    render(<MessageWithCitations content="Combined [1][2]." citations={citations} />);
    expect(screen.getByLabelText('Citation 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Citation 2')).toBeInTheDocument();
  });

  it('handles markers at the start and end of the content', () => {
    const citations = [makeCitation({ marker: 1 }), makeCitation({ marker: 2, chunkId: 'c2' })];
    render(<MessageWithCitations content="[1] opens, closes [2]" citations={citations} />);
    expect(screen.getByLabelText('Citation 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Citation 2')).toBeInTheDocument();
  });

  it('omits the excerpt paragraph when the excerpt is empty', async () => {
    const user = userEvent.setup();
    const citations = [makeCitation({ excerpt: '' })];
    render(<MessageWithCitations content="See [1]" citations={citations} />);
    await user.click(screen.getByRole('button', { name: /sources \(1 used of 1\)/i }));
    // The list item still renders the document name, but no excerpt <p>.
    expect(screen.getByText('Tenancy Guide')).toBeInTheDocument();
    expect(screen.queryByText(/deposit must be protected/)).not.toBeInTheDocument();
  });

  it('expands citation markers inside every supported markdown wrapper', () => {
    const citations = Array.from({ length: 8 }, (_, i) =>
      makeCitation({ marker: i + 1, chunkId: `c${i + 1}` })
    );
    // One marker per element type so every entry in the Markdown
    // component override map is exercised (h1-h6, li, blockquote).
    const content = [
      '# H1 [1]',
      '',
      '## H2 [2]',
      '',
      '### H3 [3]',
      '',
      '#### H4 [4]',
      '',
      '##### H5 [5]',
      '',
      '###### H6 [6]',
      '',
      '- list item [7]',
      '',
      '> blockquote [8]',
    ].join('\n');
    render(<MessageWithCitations content={content} citations={citations} />);
    for (let marker = 1; marker <= 8; marker++) {
      expect(screen.getByLabelText(`Citation ${marker}`)).toBeInTheDocument();
    }
  });

  it('invokes the onCitationClick callback in external panel mode instead of opening an inline panel', async () => {
    const user = userEvent.setup();
    const onCitationClick = vi.fn();
    render(
      <MessageWithCitations
        content="See [1] for context."
        citations={[makeCitation({ marker: 1 })]}
        panelMode="external"
        onCitationClick={onCitationClick}
      />
    );

    // No inline Sources panel in external mode.
    expect(screen.queryByRole('button', { name: /sources/i })).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Citation 1'));
    expect(onCitationClick).toHaveBeenCalledOnce();
  });
});

describe('getCitedMarkers', () => {
  it('returns only the markers cited in the body that have a matching citation', () => {
    const valid = new Set([1, 2, 3]);
    expect(getCitedMarkers('Uses [1] and [3] here.', valid)).toEqual(new Set([1, 3]));
  });

  it('excludes bracketed numbers with no matching citation (possible hallucination)', () => {
    const valid = new Set([1, 2]);
    expect(getCitedMarkers('Cites [1] and [9].', valid)).toEqual(new Set([1]));
  });

  it('returns an empty set when the body cites nothing', () => {
    expect(getCitedMarkers('No markers here.', new Set([1, 2]))).toEqual(new Set());
  });

  it('returns an empty set when there are no valid markers', () => {
    expect(getCitedMarkers('See [1].', new Set())).toEqual(new Set());
  });

  it('counts a repeated marker once', () => {
    expect(getCitedMarkers('[1] then [1] again.', new Set([1]))).toEqual(new Set([1]));
  });
});

describe('formatSourcesLabel', () => {
  it('reports "X used of Y" when at least one source was cited', () => {
    expect(formatSourcesLabel(7, 2)).toBe('Sources (2 used of 7)');
  });

  it('reports only the retrieved count when nothing was cited', () => {
    expect(formatSourcesLabel(7, 0)).toBe('Sources (7 retrieved)');
  });
});

describe('relevancePercent / topRelevancePercent', () => {
  it('renders the cosine similarity as a clamped integer percent', () => {
    expect(relevancePercent(makeCitation({ similarity: 0.912 }))).toBe(91);
  });

  it('prefers the hybrid blended score over raw similarity when present', () => {
    expect(relevancePercent(makeCitation({ similarity: 0.5, finalScore: 0.83 }))).toBe(83);
  });

  it('clamps an out-of-range cosine value into [0, 100]', () => {
    expect(relevancePercent(makeCitation({ similarity: 1.4 }))).toBe(100);
    expect(relevancePercent(makeCitation({ similarity: -0.2 }))).toBe(0);
  });

  it('returns the highest match across sources, or null when there are none', () => {
    const citations = [
      makeCitation({ marker: 1, similarity: 0.4 }),
      makeCitation({ marker: 2, similarity: 0.87 }),
    ];
    expect(topRelevancePercent(citations)).toBe(87);
    expect(topRelevancePercent([])).toBeNull();
  });
});

describe('CitationsList usage + relevance', () => {
  it('badges cited sources, dims uncited ones, and renders the explainer caption', () => {
    const citations = [
      makeCitation({ marker: 1, documentName: 'Used Doc' }),
      makeCitation({ marker: 2, chunkId: 'c2', documentName: 'Unused Doc' }),
    ];
    render(<CitationsList citations={citations} citedMarkers={new Set([1])} />);

    // The cited source gets a "Used" badge; the uncited one does not.
    expect(screen.getByText('Used')).toBeInTheDocument();

    const items = screen.getAllByRole('listitem');
    const usedItem = items.find((li) => li.id === 'citation-1')!;
    const unusedItem = items.find((li) => li.id === 'citation-2')!;
    expect(usedItem.className).not.toContain('opacity-60');
    expect(unusedItem.className).toContain('opacity-60');

    // The explainer caption spells out the agentic (non-injected) mechanism
    // and the "Used" clause when usage info is present.
    expect(screen.getByText(/passed to the model as tool results/i)).toBeInTheDocument();
    expect(screen.getByText(/“Used” marks the ones the model cited/i)).toBeInTheDocument();
  });

  it('shows a per-source match score for every source', () => {
    const citations = [
      makeCitation({ marker: 1, similarity: 0.91 }),
      makeCitation({ marker: 2, chunkId: 'c2', similarity: 0.42 }),
    ];
    render(<CitationsList citations={citations} citedMarkers={new Set([1])} />);
    expect(screen.getByText('91% match')).toBeInTheDocument();
    expect(screen.getByText('42% match')).toBeInTheDocument();
  });

  it('always renders the mechanism caption but omits the "Used" clause without usage info', () => {
    const citations = [makeCitation({ marker: 1 })];
    render(<CitationsList citations={citations} />);

    expect(screen.queryByText('Used')).not.toBeInTheDocument();
    expect(screen.getByText(/passed to the model as tool results/i)).toBeInTheDocument();
    expect(screen.queryByText(/“Used” marks the ones the model cited/i)).not.toBeInTheDocument();
    expect(screen.getByRole('listitem').className).not.toContain('opacity-60');
  });
});
