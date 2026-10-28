// @vitest-environment happy-dom

/**
 * DatasetUploadForm — refused upload (§124)
 *
 * A multipart upload sends its own fetch; a refused one is read through
 * apiErrorFromResponse and shown directly above the Upload button, focused.
 *
 * @see components/admin/orchestration/evaluations-foundations/dataset-upload-form.tsx
 * @see .context/ui/form-errors.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DatasetUploadForm } from '@/components/admin/orchestration/evaluations-foundations/dataset-upload-form';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}));

describe('DatasetUploadForm — refused upload', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: false,
              error: { code: 'VALIDATION_ERROR', message: 'Row 3 is missing an input column' },
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the server message directly above Upload, and focuses it', async () => {
    const user = userEvent.setup();
    const { container } = render(<DatasetUploadForm />);
    const fileInput = container.querySelector<HTMLInputElement>('#file');
    if (!fileInput) throw new Error('file input not found');
    await user.upload(fileInput, new File(['input\nhello'], 'faq.csv', { type: 'text/csv' }));
    const upload = screen.getByRole('button', { name: /upload dataset/i });
    await user.click(upload);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Row 3 is missing an input column');
    expect(alert.nextElementSibling).toContainElement(upload);
    await waitFor(() => expect(alert).toHaveFocus());
  });
});
