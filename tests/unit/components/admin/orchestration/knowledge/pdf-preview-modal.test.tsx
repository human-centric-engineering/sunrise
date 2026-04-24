/**
 * PdfPreviewModal Component Tests
 *
 * @see components/admin/orchestration/knowledge/pdf-preview-modal.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PdfPreviewModal } from '@/components/admin/orchestration/knowledge/pdf-preview-modal';
import type { PdfPreviewData } from '@/components/admin/orchestration/knowledge/document-upload-zone';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const mockPreviewData: PdfPreviewData = {
  document: { id: 'doc-1', name: 'Report', fileName: 'report.pdf', status: 'pending_review' },
  preview: {
    extractedText: 'This is the extracted text from the PDF.',
    title: 'Annual Report 2025',
    author: 'Jane Smith',
    sectionCount: 12,
    warnings: ['Some pages had low OCR confidence'],
    requiresConfirmation: true,
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PdfPreviewModal', () => {
  const onOpenChange = vi.fn();
  const onConfirmed = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, data: { document: { id: 'doc-1' } } }),
    });
  });

  it('renders document metadata', () => {
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    expect(screen.getByText('Annual Report 2025')).toBeInTheDocument();
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('renders extraction warnings', () => {
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    expect(screen.getByText('Extraction warnings')).toBeInTheDocument();
    expect(screen.getByText('Some pages had low OCR confidence')).toBeInTheDocument();
  });

  it('renders extracted text in textarea', () => {
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /extracted text/i });
    expect(textarea).toHaveValue('This is the extracted text from the PDF.');
  });

  it('calls confirm endpoint on Confirm & Chunk click', async () => {
    const user = userEvent.setup();
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    await user.click(screen.getByRole('button', { name: /confirm & chunk/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/documents/doc-1/confirm'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"documentId":"doc-1"'),
        })
      );
      expect(onConfirmed).toHaveBeenCalled();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('sends corrected content when textarea is edited', async () => {
    const user = userEvent.setup();
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    const textarea = screen.getByRole('textbox', { name: /extracted text/i });
    await user.clear(textarea);
    await user.type(textarea, 'Corrected text');

    await user.click(screen.getByRole('button', { name: /confirm & chunk/i }));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/confirm')
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call![1].body as string);
      expect(body.correctedContent).toBe('Corrected text');
    });
  });

  it('sends category when provided', async () => {
    const user = userEvent.setup();
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    const categoryInput = screen.getByPlaceholderText(/e\.g\. sales/i);
    await user.type(categoryInput, 'reports');

    await user.click(screen.getByRole('button', { name: /confirm & chunk/i }));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/confirm')
      );
      const body = JSON.parse(call![1].body as string);
      expect(body.category).toBe('reports');
    });
  });

  it('calls DELETE on Discard', async () => {
    const user = userEvent.setup();
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    await user.click(screen.getByRole('button', { name: /discard/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/documents/doc-1'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
      expect(onConfirmed).not.toHaveBeenCalled();
    });
  });

  it('shows error message when confirm fails', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'Document not in pending_review state' } }),
    });

    const user = userEvent.setup();
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    await user.click(screen.getByRole('button', { name: /confirm & chunk/i }));

    await waitFor(() => {
      expect(screen.getByText('Document not in pending_review state')).toBeInTheDocument();
    });

    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('shows fallback error message when non-ok response has no parseable body', async () => {
    // Simulate a 500 response whose JSON parse fails — exercises the `.catch(() => null)` branch
    // that produces the "Confirmation failed (500)" fallback message.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('invalid json')),
    });

    const user = userEvent.setup();
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    await user.click(screen.getByRole('button', { name: /confirm & chunk/i }));

    // The component constructs "Confirmation failed (500)" when body is null
    await waitFor(() => {
      expect(screen.getByText('Confirmation failed (500)')).toBeInTheDocument();
    });

    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('shows error message when fetch throws a network error', async () => {
    // Simulate a hard network failure (fetch rejects entirely — no response object)
    mockFetch.mockRejectedValue(new Error('Network request failed'));

    const user = userEvent.setup();
    render(
      <PdfPreviewModal
        data={mockPreviewData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    await user.click(screen.getByRole('button', { name: /confirm & chunk/i }));

    // The catch block propagates err.message directly
    await waitFor(() => {
      expect(screen.getByText('Network request failed')).toBeInTheDocument();
    });

    // onConfirmed and onOpenChange must not be called — the dialog stays open
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('does not render when data is null', () => {
    render(
      <PdfPreviewModal
        data={null}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    expect(screen.queryByText('Review PDF Extraction')).not.toBeInTheDocument();
  });

  it('hides warnings section when there are none', () => {
    const noWarningsData = {
      ...mockPreviewData,
      preview: { ...mockPreviewData.preview, warnings: [] },
    };

    render(
      <PdfPreviewModal
        data={noWarningsData}
        open={true}
        onOpenChange={onOpenChange}
        onConfirmed={onConfirmed}
      />
    );

    expect(screen.queryByText('Extraction warnings')).not.toBeInTheDocument();
  });
});
