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

  it('renders the drop zone', async () => {
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    expect(screen.getByText(/drop files here/i)).toBeInTheDocument();
  });

  it('renders accepted format text', () => {
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    expect(screen.getByText(/\.md, \.txt, \.epub, \.docx, \.pdf/)).toBeInTheDocument();
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
      expect(onUploadComplete).not.toHaveBeenCalled();
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

  it('opens file picker on Enter key', async () => {
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;
    const input = screen.getByLabelText(/upload document/i);
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.keyDown(dropZone, { key: 'Enter' });

    expect(clickSpy).toHaveBeenCalled();
  });

  it('opens file picker on Space key', async () => {
    await act(async () => {
      render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);
    });

    const dropZone = screen.getByText(/drop files here/i).closest('[role="button"]')!;
    const input = screen.getByLabelText(/upload document/i);
    const clickSpy = vi.spyOn(input, 'click');

    fireEvent.keyDown(dropZone, { key: ' ' });

    expect(clickSpy).toHaveBeenCalled();
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
      expect(onUploadComplete).toHaveBeenCalled();
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
    expect(onUploadComplete).toHaveBeenCalled();
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
    expect(onUploadComplete).not.toHaveBeenCalled();
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
      expect(onUploadComplete).toHaveBeenCalled();
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
    expect(onUploadComplete).not.toHaveBeenCalled();
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

  it('selects a category suggestion on mousedown', async () => {
    // Arrange: categories available in meta-tags
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/meta-tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                app: {
                  categories: [
                    { value: 'sales', chunkCount: 5, documentCount: 1 },
                    { value: 'engineering', chunkCount: 3, documentCount: 1 },
                  ],
                  keywords: [],
                },
                system: { categories: [], keywords: [] },
              },
            }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    });

    const user = userEvent.setup();
    render(<DocumentUploadZone onUploadComplete={onUploadComplete} />);

    // Stage a file so the category input appears
    const input = screen.getByLabelText(/upload document/i);
    const validFile = new File(['# Hello'], 'readme.md', { type: 'text/markdown' });
    fireEvent.change(input, { target: { files: [validFile] } });

    await waitFor(() => expect(screen.getByPlaceholderText(/e\.g\. sales/i)).toBeInTheDocument());

    // Act: type partial text to show suggestions, then select one
    await user.type(screen.getByPlaceholderText(/e\.g\. sales/i), 'sal');

    await waitFor(() => expect(screen.getByText('sales')).toBeInTheDocument());

    // Fire mousedown on the suggestion button
    fireEvent.mouseDown(screen.getByText('sales'));

    // Assert: category input set to selected suggestion
    await waitFor(() => {
      const catInput = screen.getByPlaceholderText(/e\.g\. sales/i);
      expect((catInput as HTMLInputElement).value).toBe('sales');
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
