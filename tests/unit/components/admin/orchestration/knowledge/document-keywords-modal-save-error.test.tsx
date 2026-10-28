// @vitest-environment happy-dom

/**
 * DocumentKeywordsModal — an enrich in flight (§124)
 *
 * While the enrich runs, the dialog is committed to it: its buttons are
 * disabled and Escape does not close it, so a late failure shows inside this
 * document's dialog and never in the next document's.
 *
 * @see components/admin/orchestration/knowledge/document-keywords-modal.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentKeywordsModal } from '@/components/admin/orchestration/knowledge/document-keywords-modal';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const mockFetch = vi.fn();
let answerEnrich: (res: Response) => void = () => {};

describe('DocumentKeywordsModal — an enrich in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.fetch = mockFetch;
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>((r) => (answerEnrich = r));
      return Promise.resolve(
        json(200, { success: true, data: { chunks: [{ id: 'c1', keywords: 'bm25' }] } })
      );
    });
  });

  const posts = () => mockFetch.mock.calls.filter(([, init]) => init?.method === 'POST');

  it('disables the confirm and Cancel while the enrich runs, so a second click sends nothing', async () => {
    const user = userEvent.setup();
    render(
      <DocumentKeywordsModal
        documentId="doc-1"
        documentName="Guide A"
        open
        onOpenChange={vi.fn()}
      />
    );

    const dialog = await screen.findByRole('dialog');
    await screen.findByText('bm25');
    await user.click(within(dialog).getByRole('button', { name: /re-enrich keywords/i }));
    await user.click(within(dialog).getByRole('button', { name: /yes, overwrite/i }));

    const pending = within(dialog).getByRole('button', { name: /enriching/i });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(pending);
    expect(posts()).toHaveLength(1);

    answerEnrich(json(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'X' } }));
    await within(dialog).findByRole('alert');
    expect(posts()).toHaveLength(1);
  });

  it("ignores Escape while the enrich runs, and document A's late failure never shows for B", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentKeywordsModal
        documentId="doc-1"
        documentName="Guide A"
        open
        onOpenChange={onOpenChange}
      />
    );

    const dialog = await screen.findByRole('dialog');
    await screen.findByText('bm25');
    await user.click(within(dialog).getByRole('button', { name: /re-enrich keywords/i }));
    await user.click(within(dialog).getByRole('button', { name: /yes, overwrite/i }));
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    answerEnrich(json(503, { success: false, error: { code: 'NO_MODEL', message: 'Boom A' } }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    rerender(
      <DocumentKeywordsModal
        documentId="doc-1"
        documentName="Guide A"
        open={false}
        onOpenChange={onOpenChange}
      />
    );
    rerender(
      <DocumentKeywordsModal
        documentId="doc-2"
        documentName="Guide B"
        open
        onOpenChange={onOpenChange}
      />
    );
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByText('bm25')).toBeInTheDocument());
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });

  it('clears a failed enrich when the document switches while the dialog stays open', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DocumentKeywordsModal
        documentId="doc-1"
        documentName="Guide A"
        open
        onOpenChange={vi.fn()}
      />
    );
    const dialog = await screen.findByRole('dialog');
    await screen.findByText('bm25');
    await user.click(within(dialog).getByRole('button', { name: /re-enrich keywords/i }));
    await user.click(within(dialog).getByRole('button', { name: /yes, overwrite/i }));
    answerEnrich(json(503, { success: false, error: { code: 'NO_MODEL', message: 'Boom A' } }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    rerender(
      <DocumentKeywordsModal
        documentId="doc-2"
        documentName="Guide B"
        open
        onOpenChange={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument());
  });
});
