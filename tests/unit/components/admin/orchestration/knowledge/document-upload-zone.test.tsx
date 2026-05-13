/**
 * DocumentUploadZone Component Tests
 *
 * @see components/admin/orchestration/knowledge/document-upload-zone.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocumentUploadZone } from '@/components/admin/orchestration/knowledge/document-upload-zone';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// apiClient.get is used for the tags fetch and apiClient.post for inline tag creation
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  APIClientError: class APIClientError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'APIClientError';
    }
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Default mock that handles the tags fetch and upload. */
function setupDefaultMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/knowledge/tags')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, data: [] }),
      });
    }
    // Match the real uploadResponseSchema shape: { data?: { document?, preview? } }
    // The component calls uploadResponseSchema.parse(body) — { success: true } passes
    // only because Zod strips unknown keys, leaving {}, but callers relying on data.document
    // would get undefined. Use the correct envelope so the shape stays honest.
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
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

  it('renders the drop zone', async () => {
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
  });

  it('renders accepted format text', () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    expect(screen.getByText(/\.md, \.txt, \.csv, \.epub, \.docx, \.pdf/)).toBeInTheDocument();
  });

  it('renders the inline upload explainer with a "Read full guide" link', () => {
    // Pinning this so a future refactor doesn't quietly drop the
    // explainer — it's the user-facing answer to "what happens to my
    // document on upload, and what will the graph show?"
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    expect(screen.getByText(/how upload works/i)).toBeInTheDocument();
    // The pipeline summary mentions chunks + the embedding dimension,
    // since users have asked "what is the difference between a chunk
    // and an embedding".
    expect(screen.getByText(/1,536-dimension vector/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /read full guide/i })).toBeInTheDocument();
  });

  it('rejects files over 50 MB', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const largeFile = new File(['x'.repeat(51 * 1024 * 1024)], 'big.md', {
      type: 'text/markdown',
    });

    fireEvent.change(input, { target: { files: [largeFile] } });

    await waitFor(() => {
      expect(screen.getByText(/exceeds 50 mb/i)).toBeInTheDocument();
    });

    // File should not be staged
    expect(screen.queryByRole('button', { name: /upload/i })).not.toBeInTheDocument();
  });

  it('rejects unsupported file extensions', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const htmlFile = new File(['content'], 'doc.html', { type: 'text/html' });

    fireEvent.change(input, { target: { files: [htmlFile] } });

    await waitFor(() => {
      expect(screen.getByText(/unsupported file type/i)).toBeInTheDocument();
    });
  });

  it('accepts PDF files', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const pdfFile = new File(['content'], 'doc.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByText('doc.pdf')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });
  });

  it('accepts EPUB files', async () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const epubFile = new File(['content'], 'book.epub', { type: 'application/epub+zip' });

    fireEvent.change(input, { target: { files: [epubFile] } });

    await waitFor(() => {
      expect(screen.getByText('book.epub')).toBeInTheDocument();
    });
  });

  it('calls onPdfPreview when upload returns a preview response', async () => {
    const onPdfPreview = vi.fn();
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
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                document: {
                  id: 'doc-1',
                  name: 'test.pdf',
                  fileName: 'test.pdf',
                  status: 'pending_review',
                },
                preview: {
                  extractedText: 'Hello world',
                  title: 'Test PDF',
                  author: null,
                  sectionCount: 3,
                  warnings: [],
                  requiresConfirmation: true,
                },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} onPdfPreview={onPdfPreview} />);

    const input = screen.getByLabelText(/upload document/i);
    const pdfFile = new File(['content'], 'test.pdf', { type: 'application/pdf' });

    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      expect(onPdfPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          document: expect.objectContaining({ id: 'doc-1' }),
          preview: expect.objectContaining({ requiresConfirmation: true }),
        })
      );
      expect(onUploadComplete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
      expect(onUploadComplete).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    });
  });

  it('sends selected tagIds in form data when tags are picked', async () => {
    // Mock apiClient.get to return a tag so the picker can offer it.
    // The component calls apiClient.get<TagRow[]>(KNOWLEDGE_TAGS + '?limit=100') on mount.
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue([
      { id: 'tag-cuid-1', slug: 'engineering', name: 'Engineering' },
    ] as never);

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [validFile] } });

    // Wait for the staged-file UI (the Tags combobox lives in there).
    const combobox = await screen.findByRole('combobox');
    await user.click(combobox);

    // Pick the only tag option.
    await user.click(await screen.findByText('Engineering'));
    // Close the popover so the upload button is hittable.
    await user.keyboard('{Escape}');

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
      expect(formData.getAll('tagIds')).toEqual(['tag-cuid-1']);
    });
  });

  it('handles drag-and-drop to stage a file', async () => {
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;
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

  it('removes drag highlight on drag leave', async () => {
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;

    fireEvent.dragEnter(dropZone, { preventDefault: vi.fn() });
    expect(dropZone.className).toContain('border-primary');

    fireEvent.dragLeave(dropZone);
    expect(dropZone.className).not.toContain('border-primary bg-primary/5');
  });

  it('stages a file after Enter key activates the drop zone', async () => {
    // The drop zone is a role="button" div that calls inputRef.current?.click() on Enter.
    // In jsdom, click() on a hidden file input does not open a picker, but the onKeyDown
    // handler wires the key → click → the change event. We verify the downstream DOM
    // effect (file appears staged) rather than asserting the spy was called, which would
    // pass even if the wrong element received the click.
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;
    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'enter-key.md', { type: 'text/markdown' });

    // Simulate Enter key activating the drop zone, then a file being selected via change
    fireEvent.keyDown(dropZone, { key: 'Enter' });
    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByText('enter-key.md')).toBeInTheDocument();
    });
  });

  it('stages a file after Space key activates the drop zone', async () => {
    // Same rationale as the Enter key test: assert DOM output (file staged),
    // not just that a spy was called. This catches wiring the wrong key handler.
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;
    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'space-key.md', { type: 'text/markdown' });

    // Simulate Space key activating the drop zone, then a file being selected via change
    fireEvent.keyDown(dropZone, { key: ' ' });
    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => {
      expect(screen.getByText('space-key.md')).toBeInTheDocument();
    });
  });

  it('allows clearing a staged file', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

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
      expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
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

    expect(onUploadComplete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows error message when upload fetch rejects (network error)', async () => {
    // The component's catch block handles `err instanceof Error` — this tests the
    // fetch-rejects path (network failure), not just a non-ok HTTP response.
    mockFetch.mockImplementation((url: string, options?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({ data: { app: { categories: [] }, system: { categories: [] } } }),
        });
      }
      if (options?.method === 'POST') {
        return Promise.reject(new Error('Failed to fetch'));
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) });
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

    // Assert: network error message shown in the error paragraph, upload not completed
    await waitFor(() => {
      expect(screen.getByText('Failed to fetch')).toBeInTheDocument();
    });
    expect(onUploadComplete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
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
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

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
      expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
    });
  });

  it('bulk uploads multiple files and calls onUploadComplete', async () => {
    // Arrange: mock returns success for bulk endpoint
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
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                results: [
                  { fileName: 'file1.md', status: 'success' },
                  { fileName: 'file2.md', status: 'success' },
                ],
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const file1 = new File(['# A'], 'file1.md', { type: 'text/markdown' });
    const file2 = new File(['# B'], 'file2.md', { type: 'text/markdown' });

    // Act: stage two files
    fireEvent.change(input, { target: { files: [file1, file2] } });

    await waitFor(() => {
      expect(screen.getByText('file1.md')).toBeInTheDocument();
      expect(screen.getByText('file2.md')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /upload 2 files/i }));

    // Assert: bulk endpoint was called and onUploadComplete fired
    await waitFor(() => {
      const bulkCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/bulk')
      );
      expect(bulkCall).toBeDefined();
      expect(onUploadComplete).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    });
  });

  it('shows error from bulk upload when results contain errors', async () => {
    // Arrange: bulk returns partial errors
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
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                results: [
                  { fileName: 'bad.md', status: 'error', error: 'Parse error' },
                  { fileName: 'ok.md', status: 'success' },
                ],
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const file1 = new File(['x'], 'bad.md', { type: 'text/markdown' });
    const file2 = new File(['y'], 'ok.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [file1, file2] } });

    await waitFor(() => expect(screen.getByText('bad.md')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /upload 2 files/i }));

    // Assert: error text from bulk result is shown
    await waitFor(() => {
      expect(screen.getByText(/bad\.md: Parse error/i)).toBeInTheDocument();
    });
    // onUploadComplete still fires even when there are partial errors
    expect(onUploadComplete).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
  });

  it('shows skipped PDF message when bulk upload has skipped_pdf results', async () => {
    // Arrange: bulk returns skipped_pdf for one file
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
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                results: [
                  { fileName: 'skip.pdf', status: 'skipped_pdf' },
                  { fileName: 'ok.md', status: 'success' },
                ],
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const pdfFile = new File(['%PDF'], 'skip.pdf', { type: 'application/pdf' });
    const mdFile = new File(['# ok'], 'ok.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [pdfFile, mdFile] } });
    await waitFor(() => expect(screen.getByText('skip.pdf')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /upload 2 files/i }));

    // Assert: skipped PDF notice displayed
    await waitFor(() => {
      expect(screen.getByText(/PDF\(s\) skipped/i)).toBeInTheDocument();
    });
  });

  it('shows error on bulk upload HTTP failure', async () => {
    // Arrange: bulk endpoint returns non-ok
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
          json: () => Promise.resolve({ error: { message: 'Bulk limit exceeded' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const file1 = new File(['x'], 'file1.md', { type: 'text/markdown' });
    const file2 = new File(['y'], 'file2.md', { type: 'text/markdown' });

    fireEvent.change(input, { target: { files: [file1, file2] } });
    await waitFor(() => expect(screen.getByText('file1.md')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: /upload 2 files/i }));

    await waitFor(() => {
      expect(screen.getByText('Bulk limit exceeded')).toBeInTheDocument();
    });
    expect(onUploadComplete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('deduplicates files with the same name when adding multiple times', async () => {
    // Arrange: stage the same file twice
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const file1 = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });
    const file1Again = new File(['# Dup'], 'readme.md', { type: 'text/markdown' });

    // Act: stage once
    fireEvent.change(input, { target: { files: [file1] } });
    await waitFor(() => expect(screen.getByText('readme.md')).toBeInTheDocument());

    // Act: stage same-named file again
    fireEvent.change(input, { target: { files: [file1Again] } });

    // Assert: still only one entry visible (deduplicated)
    await waitFor(() => {
      const matches = screen.getAllByText('readme.md');
      expect(matches).toHaveLength(1);
    });
  });

  it('rejects when more than 10 files are staged', async () => {
    // Arrange: stage 10 files first, then try to add one more
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);

    // Stage 10 files
    const tenFiles = Array.from({ length: 10 }, (_, i) => {
      return new File(['x'], `file${i}.md`, { type: 'text/markdown' });
    });
    fireEvent.change(input, { target: { files: tenFiles } });

    await waitFor(() => {
      expect(screen.getByText('file0.md')).toBeInTheDocument();
    });

    // Act: try to add one more (unique name)
    const eleventh = new File(['y'], 'eleventh.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [eleventh] } });

    // Assert: max 10 error shown
    await waitFor(() => {
      expect(screen.getByText(/maximum 10 files/i)).toBeInTheDocument();
    });
  });

  it('clears all staged files when "Clear all" is clicked', async () => {
    // Arrange: stage a file
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => expect(screen.getByText('readme.md')).toBeInTheDocument());

    // Act: click Clear all
    await user.click(screen.getByRole('button', { name: /clear all/i }));

    // Assert: drop zone re-shown, staged file gone
    await waitFor(() => {
      expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('readme.md')).not.toBeInTheDocument();
  });

  it('fetches from URL successfully and calls onUploadComplete', async () => {
    // Arrange: fetch-url endpoint succeeds
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
      if (typeof url === 'string' && url.includes('/fetch-url')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    // Act: type a URL and click Fetch
    const urlInput = screen.getByPlaceholderText(/https:\/\/example\.com/i);
    await user.type(urlInput, 'https://example.com/doc.md');
    await user.click(screen.getByRole('button', { name: /^fetch$/i }));

    // Assert: fetch-url endpoint called and onUploadComplete fired
    await waitFor(() => {
      const fetchUrlCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/fetch-url')
      );
      expect(fetchUrlCall).toBeDefined();
      expect(onUploadComplete).toHaveBeenCalled(); // test-review:accept no_arg_called — UI callback-fired guard;
    });
  });

  it('shows error when URL fetch fails with a server error message', async () => {
    // Arrange: fetch-url endpoint returns non-ok with a message
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
      if (typeof url === 'string' && url.includes('/fetch-url')) {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.resolve({ error: { message: 'URL not reachable' } }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/example\.com/i);
    await user.type(urlInput, 'https://bad-url.example.com/doc.md');
    await user.click(screen.getByRole('button', { name: /^fetch$/i }));

    // Assert: server error message shown in FetchFromUrl section
    await waitFor(() => {
      expect(screen.getByText('URL not reachable')).toBeInTheDocument();
    });
    expect(onUploadComplete).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard: function must not be called;
  });

  it('shows error when URL fetch throws a network error', async () => {
    // Arrange: fetch rejects
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
      return Promise.reject(new Error('Network unreachable'));
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/example\.com/i);
    await user.type(urlInput, 'https://example.com/doc.md');
    await user.click(screen.getByRole('button', { name: /^fetch$/i }));

    await waitFor(() => {
      expect(screen.getByText('Network unreachable')).toBeInTheDocument();
    });
  });

  it('does not fetch when URL input is empty', async () => {
    // Arrange: render without typing a URL
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const fetchBtn = screen.getByRole('button', { name: /^fetch$/i });

    // Assert: Fetch button is disabled when URL is empty
    expect(fetchBtn).toBeDisabled();
  });

  it('triggers fetch on Enter key in the URL input', async () => {
    // Arrange: fetch-url endpoint succeeds
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
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const urlInput = screen.getByPlaceholderText(/https:\/\/example\.com/i);
    await user.type(urlInput, 'https://example.com/doc.md');

    // Act: press Enter
    fireEvent.keyDown(urlInput, { key: 'Enter' });

    // Assert: fetch-url endpoint called
    await waitFor(() => {
      const fetchUrlCall = mockFetch.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/fetch-url')
      );
      expect(fetchUrlCall).toBeDefined();
    });
  });

  // The legacy free-text Category input (with `/meta-tags` autocomplete) was
  // removed when the managed Tags taxonomy shipped — see the new
  // KnowledgeAccessSection / MultiSelect-based picker. The two tests that
  // exercised "type partial text to pick a category suggestion" are gone
  // along with the feature. Coverage moved to "sends selected tagIds in
  // form data when tags are picked" above.

  it('shows generic "Upload failed" when upload throws a non-Error value', async () => {
    // Covers branch 27 (line 300): `err instanceof Error ? err.message : 'Upload failed'`
    // false path — when the thrown value is NOT an Error instance.
    mockFetch.mockImplementation((_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') {
        // Deliberately throw a non-Error value to cover the `err instanceof Error` false branch.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject('plain string rejection — not an Error instance');
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: {} }) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const fileInput = screen.getByLabelText(/upload document/i);
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'test.md', { type: 'text/markdown' })] },
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^upload$/i })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    // Assert: generic fallback message shown
    await waitFor(() => {
      expect(screen.getByText('Upload failed')).toBeInTheDocument();
    });
  });

  it('handles dragDrop with empty file list gracefully (no files staged)', async () => {
    // Covers branch 28 (line 311): `if (files.length > 0)` false path.
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;

    // Drop with empty dataTransfer.files — should not stage anything or crash
    fireEvent.drop(dropZone, {
      preventDefault: vi.fn(),
      dataTransfer: { files: [] },
    });

    // Drop zone still shows (no file was staged)
    expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
  });

  it('handles non-array tags response gracefully (falls back to empty list)', async () => {
    // Covers branch 0 (line 138): `Array.isArray(tags) ? tags : []` false path.
    // When apiClient.get returns a non-array, the component uses [] instead.
    const { apiClient } = await import('@/lib/api/client');
    vi.mocked(apiClient.get).mockResolvedValue({ unexpected: 'object' } as never);

    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    // Stage a file to show the tags picker
    const fileInput = screen.getByLabelText(/upload document/i);
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'test.md', { type: 'text/markdown' })] },
    });

    await waitFor(() => {
      expect(screen.getByText('test.md')).toBeInTheDocument();
    });

    // The tags picker shows the empty placeholder text
    expect(screen.getByText(/No tags yet/i)).toBeInTheDocument();
  });

  it('does nothing when a non-Enter/Space key is pressed on the drop zone', async () => {
    // Covers branch 34 (line 359): the else path where e.key is not Enter or Space.
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;

    // Press a key that is NOT Enter or Space — handler should do nothing (no crash)
    fireEvent.keyDown(dropZone, { key: 'Tab' });

    // Drop zone still visible, no file staged
    expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
  });

  it('fires onDragOver handler on the drop zone without error', async () => {
    // Covers the onDragOver={(e) => e.preventDefault()} handler (line 354).
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;

    // dragOver should call e.preventDefault() without error
    fireEvent.dragOver(dropZone, { preventDefault: vi.fn() });

    // Drop zone still visible (no crash)
    expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
  });

  it('clicking the drop zone div triggers the file input click (onClick handler)', async () => {
    // Covers the onClick handler on the drop zone: () => inputRef.current?.click()
    // In jsdom, click() on a hidden input is a no-op, but the handler should execute.
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;

    // Click the drop zone div (not the hidden input)
    fireEvent.click(dropZone);

    // Assert: no crash, drop zone still rendered
    expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
  });

  it('opens the "Read full guide" popover and renders UploadGuideBody content', async () => {
    // Covers UploadGuideBody() component (line 723) — rendered inside the popover.
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    // Act: click the "Read full guide" button to open the popover
    await user.click(screen.getByRole('button', { name: /read full guide/i }));

    // Assert: UploadGuideBody content is now visible
    await waitFor(() => {
      // UploadGuideBody starts with "What happens when you upload"
      expect(screen.getByText('Uploading documents to the knowledge base')).toBeInTheDocument();
    });
  });

  it('allows editing the display name (title) after staging a single file', async () => {
    // Covers the title Input onChange handler (line 436).
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const fileInput = screen.getByLabelText(/upload document/i);
    const mdFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });
    fireEvent.change(fileInput, { target: { files: [mdFile] } });

    // Wait for the staged-file UI to appear (it renders the title input)
    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });

    // Act: type a custom name in the title input (id="upload-display-name")
    const titleInput = document.getElementById('upload-display-name') as HTMLInputElement;
    expect(titleInput).not.toBeNull();
    await user.clear(titleInput);
    await user.type(titleInput, 'My Custom Title');

    // Assert: value updated
    expect(titleInput).toHaveValue('My Custom Title');
  });

  it('shows the "Add more files" button and clicking it does not crash', async () => {
    // Covers the "Add more files" button onClick handler (line 407).
    // In jsdom, clicking the hidden file input doesn't open a picker,
    // but the handler executes without error.
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const mdFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [mdFile] } });

    await waitFor(() => {
      expect(screen.getByText('readme.md')).toBeInTheDocument();
    });

    // "Add more files" appears because stagedFiles.length (1) < 10
    const addMoreBtn = screen.getByRole('button', { name: /add more files/i });
    expect(addMoreBtn).toBeInTheDocument();

    // Clicking it calls inputRef.current?.click() — no error expected
    await user.click(addMoreBtn);
    // The hidden input receives focus but no file dialog opens in test env
    expect(screen.getByText('readme.md')).toBeInTheDocument();
  });

  it('shows the extract-tables checkbox when a PDF is staged', async () => {
    // Covers the PDF extract-tables checkbox (lines 502-546) and its onChange handler.
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const input = screen.getByLabelText(/upload document/i);
    const pdfFile = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [pdfFile] } });

    await waitFor(() => {
      // The checkbox is only shown for single PDF uploads
      expect(screen.getByLabelText(/extract tables/i)).toBeInTheDocument();
    });

    // Act: check the checkbox (covers onChange handler)
    const checkbox = screen.getByLabelText(/extract tables/i);
    await user.click(checkbox);
    expect(checkbox).toBeChecked();

    // Uncheck it
    await user.click(checkbox);
    expect(checkbox).not.toBeChecked();
  });

  it('sends extractTables=true in the form data when checkbox is checked for PDF', async () => {
    // Covers the extractTables=true branch in uploadFiles (lines 217-220).
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const fileInput = screen.getByLabelText(/upload document/i);
    const pdfFile = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [pdfFile] } });

    await waitFor(() => {
      expect(screen.getByLabelText(/extract tables/i)).toBeInTheDocument();
    });

    // Check the extract-tables checkbox
    await user.click(screen.getByLabelText(/extract tables/i));

    // Upload the file
    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      const uploadCall = mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('/knowledge/documents') &&
          !call[0].includes('/bulk') &&
          (call[1] as RequestInit)?.method === 'POST'
      );
      expect(uploadCall).toBeDefined();
      const formData = (uploadCall as [string, RequestInit])[1].body as FormData;
      expect(formData.get('extractTables')).toBe('true');
    });
  });

  it('sends custom title when display name differs from filename stem', async () => {
    // Covers the `trimmedName !== filenameDefault` branch in uploadFiles (line ~214).
    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    const fileInput = screen.getByLabelText(/upload document/i);
    const mdFile = new File(['# Content'], 'source.md', { type: 'text/markdown' });
    fireEvent.change(fileInput, { target: { files: [mdFile] } });

    await waitFor(() => {
      expect(screen.getByText('source.md')).toBeInTheDocument();
    });

    // Edit the display name to something different from "source" (the default)
    const titleInput = document.getElementById('upload-display-name') as HTMLInputElement;
    expect(titleInput).not.toBeNull();
    await user.clear(titleInput);
    await user.type(titleInput, 'My Custom Name');

    await user.click(screen.getByRole('button', { name: /^upload$/i }));

    await waitFor(() => {
      const uploadCall = mockFetch.mock.calls.find(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('/knowledge/documents') &&
          !call[0].includes('/bulk') &&
          (call[1] as RequestInit)?.method === 'POST'
      );
      expect(uploadCall).toBeDefined();
      const formData = (uploadCall as [string, RequestInit])[1].body as FormData;
      // The custom name is sent
      expect(formData.get('name')).toBe('My Custom Name');
    });
  });
});
