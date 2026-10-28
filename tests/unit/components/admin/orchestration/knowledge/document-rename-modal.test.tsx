// @vitest-environment happy-dom

/**
 * DocumentRenameModal Component Tests
 *
 * Covers the rename dialog opened from the Manage tab's row actions menu:
 * - Seeds the input with the current name
 * - Save is disabled until the name changes to a non-empty value
 * - Save PATCHes the document with the trimmed name and fires onSaved
 * - Surfaces an API error without closing the dialog
 *
 * @see components/admin/orchestration/knowledge/document-rename-modal.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentRenameModal } from '@/components/admin/orchestration/knowledge/document-rename-modal';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockRefresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { patch: vi.fn() },
  APIClientError: class APIClientError extends Error {
    constructor(
      message: string,
      public code = 'INTERNAL_ERROR',
      public status = 500
    ) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

import { apiClient, APIClientError } from '@/lib/api/client';

function renderModal(overrides: Partial<Parameters<typeof DocumentRenameModal>[0]> = {}) {
  const props = {
    documentId: 'doc-1',
    documentName: 'Original Name',
    open: true,
    onOpenChange: vi.fn(),
    onSaved: vi.fn(),
    ...overrides,
  };
  render(<DocumentRenameModal {...props} />);
  return props;
}

describe('DocumentRenameModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.patch).mockResolvedValue({ id: 'doc-1' });
    // happy-dom has no scrollIntoView; <SaveError> calls it when it appears.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds the input with the current document name', () => {
    renderModal();
    expect(screen.getByLabelText('Name')).toHaveValue('Original Name');
  });

  it('disables Save until the name changes', async () => {
    const user = userEvent.setup();
    renderModal();

    const save = screen.getByRole('button', { name: /^save$/i });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Name'), ' v2');
    expect(save).toBeEnabled();
  });

  it('keeps Save disabled when the trimmed name is unchanged or empty', async () => {
    const user = userEvent.setup();
    renderModal();

    const input = screen.getByLabelText('Name');
    const save = screen.getByRole('button', { name: /^save$/i });

    await user.clear(input);
    expect(save).toBeDisabled(); // empty

    await user.type(input, '   Original Name   ');
    expect(save).toBeDisabled(); // trims back to the original
  });

  it('PATCHes the trimmed name and fires onSaved on success', async () => {
    const user = userEvent.setup();
    const props = renderModal();

    const input = screen.getByLabelText('Name');
    await user.clear(input);
    await user.type(input, '  Renamed Doc  ');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents/doc-1'),
        { body: { name: 'Renamed Doc' } }
      );
    });
    expect(mockRefresh).toHaveBeenCalled();
    expect(props.onSaved).toHaveBeenCalled();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows an error and stays open when the PATCH fails', async () => {
    vi.mocked(apiClient.patch).mockRejectedValue(new APIClientError('Name already exists'));
    const user = userEvent.setup();
    const props = renderModal();

    await user.type(screen.getByLabelText('Name'), ' edit');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Name already exists');
    // Inside the dialog, directly above the footer holding Save.
    expect(screen.getByRole('dialog')).toContainElement(alert);
    expect(alert.nextElementSibling).toContainElement(
      screen.getByRole('button', { name: /^save$/i })
    );
    expect(alert).toHaveFocus();
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it('Cancel closes the dialog without saving', async () => {
    const user = userEvent.setup();
    const props = renderModal();

    await user.type(screen.getByLabelText('Name'), ' edit');
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(apiClient.patch).not.toHaveBeenCalled();
  });

  it('Enter in the input saves the trimmed name when the name changed', async () => {
    const user = userEvent.setup();
    const props = renderModal();

    const input = screen.getByLabelText('Name');
    await user.clear(input);
    await user.type(input, ' Renamed {Enter}');

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents/doc-1'),
        { body: { name: 'Renamed' } }
      );
    });
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it('Enter does nothing while the name is unchanged', async () => {
    const user = userEvent.setup();
    const props = renderModal();

    await user.type(screen.getByLabelText('Name'), '{Enter}');

    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });

  it('Enter does not start a second save while one is in flight', async () => {
    let finish!: (v: unknown) => void;
    vi.mocked(apiClient.patch).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const user = userEvent.setup();
    renderModal();

    const input = screen.getByLabelText('Name');
    await user.type(input, ' v2{Enter}');
    await screen.findByRole('button', { name: /saving/i });
    await user.type(input, '{Enter}');

    expect(apiClient.patch).toHaveBeenCalledTimes(1);
    finish({ id: 'doc-1' });
  });

  it('starts empty for a document with no name, and saves what is typed', async () => {
    const user = userEvent.setup();
    renderModal({ documentName: null });

    const input = screen.getByLabelText('Name');
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();

    await user.type(input, 'Fresh name');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(apiClient.patch).toHaveBeenCalledWith(expect.any(String), {
        body: { name: 'Fresh name' },
      });
    });
  });

  it('does not PATCH when there is no document id, even with a changed name', async () => {
    const user = userEvent.setup();
    const props = renderModal({ documentId: null });

    await user.type(screen.getByLabelText('Name'), ' edit');
    await user.click(screen.getByRole('button', { name: /^save$/i }));

    expect(apiClient.patch).not.toHaveBeenCalled();
    expect(props.onSaved).not.toHaveBeenCalled();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });
});
