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

  it('renders the citations panel with one entry per citation', () => {
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
    expect(screen.getByText('Sources (2)')).toBeInTheDocument();
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

  it('falls back to patternName when documentName is missing', () => {
    const citations = [
      makeCitation({
        documentName: null,
        patternName: 'ReAct',
      }),
    ];
    render(<MessageWithCitations content="See [1]" citations={citations} />);
    expect(screen.getByText('ReAct')).toBeInTheDocument();
  });

  it('toggles the sources panel when the heading button is clicked', async () => {
    const user = userEvent.setup();
    render(<MessageWithCitations content="See [1]" citations={[makeCitation()]} />);
    const toggle = screen.getByRole('button', { name: /sources \(1\)/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('omits the section span when section is null', () => {
    const citations = [makeCitation({ section: null })];
    render(<MessageWithCitations content="See [1]" citations={citations} />);
    const list = screen.getByRole('list');
    expect(within(list).queryByText(/·/)).not.toBeInTheDocument();
  });
});
