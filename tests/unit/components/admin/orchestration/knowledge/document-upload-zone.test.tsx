/**
 * DocumentUploadZone Component Tests
 *
 * @see components/admin/orchestration/knowledge/document-upload-zone.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { DocumentUploadZone } from '@/components/admin/orchestration/knowledge/document-upload-zone';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DocumentUploadZone', () => {
  const onUploadComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
  });

  it('renders the drop zone', () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    expect(screen.getByText(/drop a file here/i)).toBeInTheDocument();
  });

  it('renders accepted format text', () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    expect(screen.getByText(/\.md, \.markdown, \.txt/)).toBeInTheDocument();
  });

  it('rejects files over 10 MB', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const largeFile = new File(['x'.repeat(11 * 1024 * 1024)], 'big.md', {
      type: 'text/markdown',
    });

    fireEvent.change(input, { target: { files: [largeFile] } });

    await waitFor(() => {
      expect(screen.getByText(/exceeds 10 mb/i)).toBeInTheDocument();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported file extensions', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const pdfFile = new File(['content'], 'doc.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uploads valid file and calls onUploadComplete', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(onUploadComplete).toHaveBeenCalled();
    });
  });
});
