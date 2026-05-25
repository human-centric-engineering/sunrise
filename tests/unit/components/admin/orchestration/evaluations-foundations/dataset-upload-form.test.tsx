/**
 * DatasetUploadForm Component Tests
 *
 * Test coverage:
 * - Accepted extensions appear on the file input (.csv, .jsonl, .ndjson)
 * - File extension validation
 * - File size validation (10MB cap)
 * - Auto-seeds the name field from the filename stem when name is empty
 * - Validation prevents submit when no file is picked
 * - Validation prevents submit when no name is provided
 * - Successful upload posts FormData to API.ADMIN.ORCHESTRATION.EVAL_DATASETS
 * - Successful upload navigates to /admin/orchestration/evaluations/datasets/{id}
 * - Server-side API errors are displayed inline
 *
 * @see components/admin/orchestration/evaluations-foundations/dataset-upload-form.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPush = vi.fn();
const mockBack = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: mockBack,
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => ({ get: () => null }),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { DatasetUploadForm } from '@/components/admin/orchestration/evaluations-foundations/dataset-upload-form';
import { API } from '@/lib/api/endpoints';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeFile(name: string, contents = 'input\nhello', type = 'text/csv'): File {
  return new File([contents], name, { type });
}

function getFileInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('#file');
  if (!el) throw new Error('file input not found');
  return el as HTMLInputElement;
}

function getNameInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('#name');
  if (!el) throw new Error('name input not found');
  return el as HTMLInputElement;
}

function getDescriptionInput(container: HTMLElement): HTMLTextAreaElement {
  const el = container.querySelector('#description');
  if (!el) throw new Error('description input not found');
  return el as HTMLTextAreaElement;
}

function getTagsInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('#tags');
  if (!el) throw new Error('tags input not found');
  return el as HTMLInputElement;
}

function mockFetchSuccess(datasetId = 'ds-new-1'): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      data: { datasetId, caseCount: 2, contentHash: 'abc', warnings: [] },
    }),
  } as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchServerError(message: string, status = 400): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({ success: false, error: { code: 'BAD_REQUEST', message } }),
  } as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DatasetUploadForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('rendering', () => {
    it('renders all top-level fields and CTAs', () => {
      const { container } = render(<DatasetUploadForm />);
      expect(getFileInput(container)).toBeInTheDocument();
      expect(getNameInput(container)).toBeInTheDocument();
      expect(getDescriptionInput(container)).toBeInTheDocument();
      expect(getTagsInput(container)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /upload dataset/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('declares the accepted extensions on the file input', () => {
      const { container } = render(<DatasetUploadForm />);
      expect(getFileInput(container)).toHaveAttribute('accept', '.csv,.jsonl,.ndjson');
    });
  });

  describe('file validation', () => {
    it('rejects an unsupported extension', async () => {
      const { container } = render(<DatasetUploadForm />);
      // userEvent.upload respects the `accept` attribute and silently filters
      // mismatching files, so we drive the change event directly to exercise
      // the component's own extension guard.
      const input = getFileInput(container);
      const bad = makeFile('cases.txt', 'foo', 'text/plain');
      Object.defineProperty(input, 'files', { value: [bad], configurable: true });
      fireEvent.change(input);
      await waitFor(() => {
        expect(screen.getByText(/Unsupported file type/i)).toBeInTheDocument();
      });
    });

    it('rejects a file larger than the 10MB cap', async () => {
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      const tooBig = new File(['x'.repeat(11 * 1024 * 1024)], 'big.csv', { type: 'text/csv' });
      await user.upload(getFileInput(container), tooBig);
      await waitFor(() => {
        expect(screen.getByText(/exceeds 10 MB cap/i)).toBeInTheDocument();
      });
    });

    it('seeds the name field from the filename stem when name is empty', async () => {
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      await user.upload(getFileInput(container), makeFile('customer-faq-v1.csv'));
      await waitFor(() => {
        expect(getNameInput(container).value).toBe('customer-faq-v1');
      });
    });

    it('does not overwrite an existing name when a file is picked', async () => {
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      await user.type(getNameInput(container), 'manual name');
      await user.upload(getFileInput(container), makeFile('cases.csv'));
      expect(getNameInput(container).value).toBe('manual name');
    });
  });

  describe('submit validation', () => {
    it('disables the Upload button until a file is selected', async () => {
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      const submitBtn = screen.getByRole('button', { name: /upload dataset/i });
      expect(submitBtn).toBeDisabled();
      await user.type(getNameInput(container), 'My Dataset');
      // Still disabled — no file
      expect(submitBtn).toBeDisabled();
    });

    it('shows "Give the dataset a name" when file is picked but name is empty', async () => {
      mockFetchSuccess();
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      await user.upload(getFileInput(container), makeFile('cases.csv'));
      await user.clear(getNameInput(container));
      await user.click(screen.getByRole('button', { name: /upload dataset/i }));
      await waitFor(() => {
        expect(screen.getByText(/Give the dataset a name/i)).toBeInTheDocument();
      });
    });
  });

  describe('successful upload', () => {
    it('POSTs FormData to EVAL_DATASETS with file, name, description, and tags', async () => {
      const fetchMock = mockFetchSuccess('ds-99');
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);

      await user.upload(getFileInput(container), makeFile('faq.csv'));
      await user.type(getDescriptionInput(container), 'a desc');
      await user.type(getTagsInput(container), 'refund-flow, tier-1');
      await user.click(screen.getByRole('button', { name: /upload dataset/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          API.ADMIN.ORCHESTRATION.EVAL_DATASETS,
          expect.objectContaining({ method: 'POST' })
        );
      });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = init.body;
      expect(body).toBeInstanceOf(FormData);
      const fd = body as FormData;
      expect(fd.get('name')).toBe('faq');
      expect(fd.get('description')).toBe('a desc');
      expect(fd.get('tags')).toBe('refund-flow, tier-1');
      expect(fd.get('file')).toBeInstanceOf(File);
    });

    it('does not include description or tags when blank', async () => {
      const fetchMock = mockFetchSuccess('ds-99');
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      await user.upload(getFileInput(container), makeFile('faq.csv'));
      await user.click(screen.getByRole('button', { name: /upload dataset/i }));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalled();
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const fd = init.body as FormData;
      expect(fd.has('description')).toBe(false);
      expect(fd.has('tags')).toBe(false);
    });

    it('navigates to the new dataset detail page after success', async () => {
      mockFetchSuccess('ds-99');
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      await user.upload(getFileInput(container), makeFile('faq.csv'));
      await user.click(screen.getByRole('button', { name: /upload dataset/i }));

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/admin/orchestration/evaluations/datasets/ds-99');
      });
    });
  });

  describe('error handling', () => {
    it('shows the server error message inline when the API returns an error', async () => {
      mockFetchServerError('Invalid CSV header', 400);
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      await user.upload(getFileInput(container), makeFile('faq.csv'));
      await user.click(screen.getByRole('button', { name: /upload dataset/i }));

      await waitFor(() => {
        expect(screen.getByText(/Invalid CSV header/i)).toBeInTheDocument();
      });
      expect(mockPush).not.toHaveBeenCalled(); // test-review:accept no_arg_called — error-path guard
    });

    it('shows the thrown error message when fetch itself rejects', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
      const user = userEvent.setup();
      const { container } = render(<DatasetUploadForm />);
      await user.upload(getFileInput(container), makeFile('faq.csv'));
      await user.click(screen.getByRole('button', { name: /upload dataset/i }));

      await waitFor(() => {
        expect(screen.getByText(/Network down/i)).toBeInTheDocument();
      });
    });
  });

  describe('cancel', () => {
    it('calls router.back() when Cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<DatasetUploadForm />);
      await user.click(screen.getByRole('button', { name: /cancel/i }));
      expect(mockBack).toHaveBeenCalledTimes(1);
    });
  });
});
