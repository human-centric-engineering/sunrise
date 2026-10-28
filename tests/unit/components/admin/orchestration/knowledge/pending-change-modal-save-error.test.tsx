// @vitest-environment happy-dom

/**
 * PendingChangeModal — failed Accept / Reject (§124)
 *
 * A failed Accept or Reject shows directly above the dialog's buttons, takes
 * focus, and leaves the diff on screen. It used to replace the diff with the
 * error, so the admin lost what they were deciding about.
 *
 * @see components/admin/orchestration/knowledge/pending-change-modal.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockGet } = vi.hoisted(() => ({ mockGet: vi.fn() }));

vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/client')>()),
  apiClient: { get: mockGet },
}));

vi.mock('@/components/admin/orchestration/knowledge/text-diff-viewer', () => ({
  TextDiffViewer: () => <div data-testid="text-diff" />,
}));

import { PendingChangeModal } from '@/components/admin/orchestration/knowledge/pending-change-modal';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PendingChangeModal — failed Accept / Reject', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    mockGet.mockResolvedValue({
      change: {
        id: 'change-1',
        source: 'rewrite_with_llm',
        beforeContent: 'before',
        afterContent: 'after',
        sectionMarker: null,
        instructions: 'Tighten it',
      },
    });
  });

  it.each([
    ['Accept', 'The document changed since this was proposed'],
    ['Reject', 'Change already resolved'],
  ])('a failed %s shows above the buttons and keeps the diff', async (action, message) => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(json(409, { success: false, error: { code: 'CONFLICT', message } }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <PendingChangeModal
        documentId="doc-1"
        changeId="change-1"
        onClose={onClose}
        onResolved={vi.fn()}
      />
    );

    await screen.findByTestId('text-diff');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: new RegExp(`^${action}$`) }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.nextElementSibling).toContainElement(
      within(dialog).getByRole('button', { name: /^accept$/i })
    );
    expect(alert).toHaveFocus();
    // The diff is still there to decide about, and the dialog is open.
    expect(screen.getByTestId('text-diff')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('commits the dialog to an Accept in flight: both buttons disabled, a second click sends nothing', async () => {
    let answer: (res: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(
      <PendingChangeModal
        documentId="doc-1"
        changeId="change-1"
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />
    );

    await screen.findByTestId('text-diff');
    const dialog = screen.getByRole('dialog');
    const accept = within(dialog).getByRole('button', { name: /^accept$/i });
    await user.click(accept);

    expect(accept).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /^reject$/i })).toBeDisabled();
    await user.click(accept);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    answer(json(200, { success: true, data: {} }));
    await waitFor(() => expect(accept).not.toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores Escape while Accept runs, and change A's late failure never shows for change B", async () => {
    let answer: (res: Response) => void = () => {};
    globalThis.fetch = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <PendingChangeModal
        documentId="doc-1"
        changeId="change-1"
        onClose={onClose}
        onResolved={vi.fn()}
      />
    );

    await screen.findByTestId('text-diff');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^accept$/i }));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    answer(json(409, { success: false, error: { code: 'CONFLICT', message: 'Boom A' } }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom A');

    rerender(
      <PendingChangeModal
        documentId="doc-1"
        changeId="change-2"
        onClose={onClose}
        onResolved={vi.fn()}
      />
    );
    await screen.findByTestId('text-diff');
    expect(screen.queryByText(/Boom A/)).not.toBeInTheDocument();
  });
});
