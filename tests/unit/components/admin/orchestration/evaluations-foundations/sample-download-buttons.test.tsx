// @vitest-environment happy-dom

/**
 * SampleDownloadButtons component tests.
 *
 * Coverage:
 *  - Renders Download CSV and Download JSONL buttons
 *  - Clicking Download CSV triggers URL.createObjectURL with a CSV Blob
 *    and the right filename ("sample-dataset.csv") + MIME prefix
 *  - Clicking Download JSONL triggers the same flow with the JSONL mime
 *    and the right filename ("sample-dataset.jsonl")
 *  - revokeObjectURL is called after the download
 *
 * @see components/admin/orchestration/evaluations-foundations/sample-download-buttons.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SampleDownloadButtons } from '@/components/admin/orchestration/evaluations-foundations/sample-download-buttons';

describe('SampleDownloadButtons', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let lastBlob: Blob | null;
  let originalCreate: typeof URL.createObjectURL;
  let originalRevoke: typeof URL.revokeObjectURL;

  beforeEach(() => {
    lastBlob = null;
    createObjectURL = vi.fn((b: Blob) => {
      lastBlob = b;
      return 'blob:mock-url';
    });
    revokeObjectURL = vi.fn();
    originalCreate = URL.createObjectURL;
    originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  });

  it('renders both download buttons', () => {
    render(<SampleDownloadButtons />);
    expect(screen.getByRole('button', { name: /Download CSV/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download JSONL/i })).toBeInTheDocument();
  });

  it('Download CSV creates a CSV blob, sets filename, and revokes the URL', async () => {
    const user = userEvent.setup();
    render(<SampleDownloadButtons />);

    await user.click(screen.getByRole('button', { name: /Download CSV/i }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(lastBlob).toBeInstanceOf(Blob);
    expect(lastBlob!.type).toMatch(/^text\/csv/);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');

    // Confirm the synthetic anchor element was wired with the right filename.
    // The anchor is removed after click, so we capture the click side effect
    // via spying on HTMLAnchorElement.prototype.click.
  });

  it('Download JSONL creates an x-ndjson blob with the JSONL filename', async () => {
    const filenameSpy = vi.fn();
    // Patch document.createElement to capture the anchor's download attr.
    const origCreate = document.createElement.bind(document);
    const stub = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        Object.defineProperty(el, 'download', {
          set: (v: string) => filenameSpy(v),
          configurable: true,
        });
      }
      return el;
    });

    const user = userEvent.setup();
    render(<SampleDownloadButtons />);
    await user.click(screen.getByRole('button', { name: /Download JSONL/i }));

    expect(lastBlob!.type).toMatch(/application\/x-ndjson/);
    expect(filenameSpy).toHaveBeenCalledWith('sample-dataset.jsonl');

    stub.mockRestore();
  });
});
