// @vitest-environment happy-dom

/**
 * ErrorsTab — failed row actions (§124)
 *
 * A row's Retry failing shows in the one save error above the list, which
 * takes focus. A delete confirmed in the dialog that fails keeps the dialog
 * open with the error inside it, above its buttons: it used to close the
 * dialog and show nothing.
 *
 * @see components/admin/orchestration/knowledge/errors-tab.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ErrorsTab } from '@/components/admin/orchestration/knowledge/errors-tab';

const mockFetch = vi.fn();

function failedDoc(id: string, name: string) {
  return {
    id,
    name,
    fileName: `${id}.pdf`,
    fileHash: 'hash',
    chunkCount: 0,
    status: 'failed',
    scope: 'app',
    category: null,
    sourceUrl: null,
    errorMessage: 'Parsing error',
    metadata: null,
    uploadedBy: 'user-1',
    createdAt: '2025-01-15T10:00:00Z',
    updatedAt: '2025-01-15T10:00:00Z',
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The list loads two failed documents; `action` answers the retry / delete. */
function serve(action: (url: string, init?: RequestInit) => Response) {
  mockFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' || init?.method === 'DELETE') {
      return Promise.resolve(action(url, init));
    }
    return Promise.resolve(
      json(200, {
        success: true,
        data: [failedDoc('doc-1', 'Failed Report A'), failedDoc('doc-2', 'Failed Report B')],
      })
    );
  });
}

describe('ErrorsTab — failed row actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = mockFetch;
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('shows a failed Retry above the list and focuses it', async () => {
    serve(() =>
      json(409, {
        success: false,
        error: { code: 'CONFLICT', message: 'Document is already processing' },
      })
    );
    const user = userEvent.setup();
    render(<ErrorsTab />);

    await screen.findByText('Failed Report B');
    await user.click(screen.getAllByRole('button', { name: /^retry$/i })[1]);

    const alert = await screen.findByRole('alert');
    // The box sits away from the row, so it names the row.
    expect(alert).toHaveTextContent(
      'Couldn\'t retry "Failed Report B": Document is already processing'
    );
    // Directly above the list holding the rows.
    expect(alert.nextElementSibling).toContainElement(screen.getByText('Failed Report A'));
    expect(alert).toHaveFocus();
    // The row stays: nothing was retried.
    expect(screen.getByText('Failed Report B')).toBeInTheDocument();
  });

  it('keeps the delete dialog open with the failure inside it, above its buttons', async () => {
    serve(() =>
      json(403, { success: false, error: { code: 'FORBIDDEN', message: 'Not allowed to delete' } })
    );
    const user = userEvent.setup();
    render(<ErrorsTab />);

    await screen.findByText('Failed Report A');
    await user.click(screen.getAllByRole('button', { name: /^delete$/i })[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Not allowed to delete');
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^delete$/i })
    );
    expect(alert).toHaveFocus();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // The document is still listed (its name is in the dialog too).
    expect(screen.getAllByText('Failed Report A').length).toBeGreaterThan(1);
  });

  it('clears the dialog failure when it is closed and opened again', async () => {
    serve(() => json(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Boom' } }));
    const user = userEvent.setup();
    render(<ErrorsTab />);

    await screen.findByText('Failed Report A');
    await user.click(screen.getAllByRole('button', { name: /^delete$/i })[0]);
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await within(dialog).findByRole('alert');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await user.click(screen.getAllByRole('button', { name: /^delete$/i })[0]);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('commits the dialog to a delete in flight: both buttons disabled, a second click sends nothing', async () => {
    let answer: (res: Response) => void = () => {};
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise<Response>((r) => (answer = r));
      return Promise.resolve(
        json(200, { success: true, data: [failedDoc('doc-1', 'Failed Report A')] })
      );
    });
    const user = userEvent.setup();
    render(<ErrorsTab />);

    await screen.findByText('Failed Report A');
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    const pending = within(dialog).getByRole('button', { name: /deleting/i });
    expect(pending).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    await user.click(pending);
    const deletes = () => mockFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE');
    expect(deletes()).toHaveLength(1);

    answer(json(200, { success: true, data: null }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deletes()).toHaveLength(1);
  });

  it("keeps row A's late failure in row A's dialog, never in row B's", async () => {
    let answer: (res: Response) => void = () => {};
    mockFetch.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Promise<Response>((r) => (answer = r));
      return Promise.resolve(
        json(200, {
          success: true,
          data: [failedDoc('doc-1', 'Failed Report A'), failedDoc('doc-2', 'Failed Report B')],
        })
      );
    });
    const user = userEvent.setup();
    render(<ErrorsTab />);

    await screen.findByText('Failed Report A');
    await user.click(screen.getAllByRole('button', { name: /^delete$/i })[0]);
    let dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Escape while the delete runs is ignored: the dialog waits for the answer.
    await user.keyboard('{Escape}');
    answer(json(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Boom A' } }));

    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Failed Report A')).toBeInTheDocument();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    await user.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getAllByRole('button', { name: /^delete$/i })[1]);
    dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Failed Report B')).toBeInTheDocument();
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });
});
