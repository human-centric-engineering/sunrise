/**
 * DocumentUploadZone Component Tests
 *
 * @see components/admin/orchestration/knowledge/document-upload-zone.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentUploadZone } from '@/components/admin/orchestration/knowledge/document-upload-zone';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default mock that handles both meta-tags fetch and upload */
function setupDefaultMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/meta-tags')) {
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            data: {
              app: { categories: [], keywords: [] },
              system: { categories: [], keywords: [] },
            },
          }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ success: true }),
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DocumentUploadZone', () => {
  const onUploadComplete = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
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

    // File should not be staged
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
  });

  it('rejects unsupported file extensions', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const pdfFile = new File(['content'], 'doc.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument();
    });
  });

  it('stages valid file and shows upload button', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });
  });

  it('uploads staged file on Upload click and calls onUploadComplete', async () => {
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/knowledge/documents'),
        expect.objectContaining({ method: 'POST' })
      );
      expect(onUploadComplete).toHaveBeenCalled();
    });
  });

  it('sends category in form data when provided', async () => {
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. sales/i)).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText(/e\.g\. sales/i), 'engineering');
    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      const uploadCall = mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('/knowledge/documents') &&
          call[1]?.method === 'POST'
      );
      expect(uploadCall).toBeDefined();
      const formData = (uploadCall as [string, RequestInit])[1].body as FormData;
      expect(formData.get('category')).toBe('engineering');
    });
  });

  it('handles drag-and-drop to stage a file', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const dropZone = screen.getByText(/drop a file here/i).closest('[role="button"]')!;
    const validFile = new File(['# Dropped'], 'dropped.md', { type: 'text/markdown' });

    fireEvent.dragEnter(dropZone, { preventDefault: vi.fn() });
    expect(dropZone.className).toContain('border-primary');

    fireEvent.drop(dropZone, {
      preventDefault: vi.fn(),
      dataTransfer: { files: [validFile] },
    });

    await waitFor(() => {
      expect(screen.getByText('dropped.md')).toBeInTheDocument();
    });
  });

  it('removes drag highlight on drag leave', () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const dropZone = screen.getByText(/drop a file here/i).closest('[role="button"]')!;

    fireEvent.dragEnter(dropZone, { preventDefault: vi.fn() });
    expect(dropZone.className).toContain('border-primary');

    fireEvent.dragLeave(dropZone);
    expect(dropZone.className).not.toContain('border-primary bg-primary/5');
  });

  it('opens file picker on Enter key', () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const dropZone = screen.getByText(/drop a file here/i).closest('[role="button"]')!;
    const input = screen.getByLabelText(/upload document/i);
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.keyDown(dropZone, { key: 'Enter' });

    expect(clickSpy).toHaveBeenCalled();
  });

  it('opens file picker on Space key', () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const dropZone = screen.getByText(/drop a file here/i).closest('[role="button"]')!;
    const input = screen.getByLabelText(/upload document/i);
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.keyDown(dropZone, { key: ' ' });

    expect(clickSpy).toHaveBeenCalled();
  });

  it('allows clearing a staged file', async () => {
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });

    // Click the X button to clear
    const clearButtons = screen.getAllByRole('button');
    const clearButton = clearButtons.find((btn) => btn.querySelector('.lucide-x'));
    expect(clearButton).toBeDefined();
    await user.click(clearButton!);

    await waitFor(() => {
      expect(screen.getByText(/drop a file here/i)).toBeInTheDocument();
    });
  });

  it('shows server error message on failed upload response', async () => {
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: { categories: [], keywords: [] },
                system: { categories: [], keywords: [] },
              },
            }),
        });
      }
      if (options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: { message: 'Duplicate document' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      expect(screen.getByText('Duplicate document')).toBeInTheDocument();
    });

    expect(onUploadComplete).not.toHaveBeenCalled();
  });

  it('shows "Uploading..." text during upload', async () => {
    let resolveUpload!: (value: unknown) => void;
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: { categories: [], keywords: [] },
                system: { categories: [], keywords: [] },
              },
            }),
        });
      }
      if (options?.method === 'POST') {
        return new Promise((resolve) => {
          resolveUpload = resolve;
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      expect(screen.getByText('Uploading...')).toBeInTheDocument();
    });

    resolveUpload({ ok: true, json: () => Promise.resolve({ success: true }) });

    await waitFor(() => {
      expect(screen.getByText(/drop a file here/i)).toBeInTheDocument();
    });
  });

  it('shows category suggestions from existing meta-tags', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: {
                  categories: [
                    { value: 'sales', chunkCount: 10, documentCount: 2 },
                    { value: 'engineering', chunkCount: 5, documentCount: 1 },
                  ],
                  keywords: [],
                },
                system: { categories: [], keywords: [] },
              },
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true }),
      });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/e\.g\. sales/i)).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText(/e\.g\. sales/i), 'sal');

    await waitFor(() => {
      expect(screen.getByText('sales')).toBeInTheDocument();
    });
  });
});
