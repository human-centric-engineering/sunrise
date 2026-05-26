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

    await waitFor(() => {
      expect(screen.getByText('Name already exists')).toBeInTheDocument();
    });
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
