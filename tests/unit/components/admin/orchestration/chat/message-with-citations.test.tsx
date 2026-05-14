/**
 * MessageWithCitations Component Tests
 *
 * Verifies the marker → superscript expansion and the sources panel
 * rendering. Plain content (no markers, no citations) renders as a
 * single text run; valid markers become anchors keyed to citation IDs;
 * markers without a matching citation get the "hallucinated" treatment.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageWithCitations } from '@/components/admin/orchestration/chat/message-with-citations';
import type { Citation } from '@/types/orchestration';

function makeCitation(overrides: Partial<Citation> = {}): Citation {
  return {
    marker: 1,
    chunkId: 'c1',
    documentId: 'd1',
    documentName: 'Tenancy Guide',
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
    expect(screen.getByText('Sources (2)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /sources \(2\)/i }));
    expect(screen.getByText('Tenancy Guide')).toBeInTheDocument();
    expect(screen.getByText('Renters Reform Act')).toBeInTheDocument();
    expect(screen.getByText(/Notice must give two months/)).toBeInTheDocument();
  });

  it('marks markers without a matching citation as hallucinated', () => {
    const citations = [makeCitation({ marker: 1 })];
    render(<MessageWithCitations content="See [1] and [3]." citations={citations} />);
    const bad = screen.getByLabelText('Unmatched citation marker 3');
    expect(bad).toBeInTheDocument();
    expect(bad).toHaveAttribute(
      'title',
      expect.stringContaining('hallucinated') as unknown as string
    );
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
    await user.click(screen.getByRole('button', { name: /sources \(1\)/i }));
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('toggles the sources panel when the heading button is clicked', async () => {
    const user = userEvent.setup();
    render(<MessageWithCitations content="See [1]" citations={[makeCitation()]} />);
    const toggle = screen.getByRole('button', { name: /sources \(1\)/i });
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
    await user.click(screen.getByRole('button', { name: /sources \(1\)/i }));
    const list = screen.getByRole('list');
    expect(within(list).queryByText(/·/)).not.toBeInTheDocument();
  });

  it('reveals a collapsed sources panel when a valid marker is clicked', async () => {
    const user = userEvent.setup();
    render(<MessageWithCitations content="See [1]" citations={[makeCitation({ marker: 1 })]} />);
    const toggle = screen.getByRole('button', { name: /sources \(1\)/i });
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
    await user.click(screen.getByRole('button', { name: /sources \(1\)/i }));
    // The list item still renders the document name, but no excerpt <p>.
    expect(screen.getByText('Tenancy Guide')).toBeInTheDocument();
    expect(screen.queryByText(/deposit must be protected/)).not.toBeInTheDocument();
  });
});
