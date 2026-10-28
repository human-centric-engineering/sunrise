// @vitest-environment happy-dom

/**
 * PdfPreviewModal — Confirm / Discard in flight (§124)
 *
 * While Confirm or Discard runs, the dialog is committed to it: both buttons
 * are disabled, and Escape does not close it, so a failure arriving late is
 * shown inside the dialog rather than nowhere.
 *
 * @see components/admin/orchestration/knowledge/pdf-preview-modal.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PdfPreviewModal } from '@/components/admin/orchestration/knowledge/pdf-preview-modal';
import type { PdfPreviewData } from '@/components/admin/orchestration/knowledge/document-upload-zone';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const DATA: PdfPreviewData = {
  document: { id: 'doc-1', name: 'Report', fileName: 'report.pdf', status: 'pending_review' },
  preview: {
    extractedText: 'Extracted text.',
    title: 'Annual Report',
    author: null,
    sectionCount: 1,
    warnings: [],
    requiresConfirmation: true,
  },
  runCleanup: false,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PdfPreviewModal — an action in flight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('disables Confirm and Discard while a Discard runs, so a second click sends nothing', async () => {
    let answer: (res: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    globalThis.fetch = fetchMock;
    const user = userEvent.setup();
    render(<PdfPreviewModal data={DATA} open onOpenChange={vi.fn()} onConfirmed={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^discard$/i }));

    const confirm = within(dialog).getByRole('button', { name: /confirm & chunk/i });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /discarding/i })).toBeDisabled();
    await user.click(confirm);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(json(500, { success: false, error: { code: 'INTERNAL_ERROR', message: 'Boom' } }));
    await waitFor(() => expect(confirm).not.toBeDisabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores Escape while Confirm runs, so a late failure shows inside the dialog', async () => {
    let answer: (res: Response) => void = () => {};
    globalThis.fetch = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    render(<PdfPreviewModal data={DATA} open onOpenChange={onOpenChange} onConfirmed={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /confirm & chunk/i }));
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    answer(json(409, { success: false, error: { code: 'CONFLICT', message: 'Boom late' } }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Boom late');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
