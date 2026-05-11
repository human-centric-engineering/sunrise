/**
 * AttachmentPickerButton component tests.
 *
 * Covers:
 * - Renders a paperclip button with the expected aria-label and accept MIME
 * - Clicking the button delegates to the hidden file input's `.click()`
 * - Selecting a valid image fires `onAttachmentsChange` with the encoded entry
 * - Selecting an invalid MIME fires `onError` and does not change attachments
 * - Remove buttons remove individual entries from the strip
 * - `disabled` prop disables the button
 * - `controlsRef.current.clear()` clears the strip
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { AttachmentPickerButton } from '@/components/admin/orchestration/chat/attachment-picker-button';

function makeFile(name: string, type: string, content = 'dummy'): File {
  return new File([content], name, { type });
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    writable: true,
    value: vi.fn().mockReturnValue('blob:mock'),
  });
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: vi.fn() });
});

describe('AttachmentPickerButton', () => {
  it('renders the paperclip button with the expected aria-label', () => {
    render(<AttachmentPickerButton />);
    const button = screen.getByRole('button', { name: /attach an image or pdf/i });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it('sets the file input accept and multiple attributes', () => {
    render(<AttachmentPickerButton />);
    const input = screen.getByTestId('attachment-picker-input');
    if (!(input instanceof HTMLInputElement)) {
      throw new Error('Expected HTMLInputElement');
    }
    expect(input.type).toBe('file');
    expect(input.multiple).toBe(true);
    expect(input.accept).toContain('image/png');
    expect(input.accept).toContain('application/pdf');
  });

  describe('acceptMime narrowing', () => {
    it('narrows accept to images only when only image MIMEs are passed', () => {
      render(
        <AttachmentPickerButton
          acceptMime={['image/png', 'image/jpeg', 'image/gif', 'image/webp']}
        />
      );
      const input = screen.getByTestId('attachment-picker-input');
      if (!(input instanceof HTMLInputElement)) throw new Error('Expected HTMLInputElement');
      expect(input.accept).not.toContain('application/pdf');
      expect(input.accept).toContain('image/png');
    });

    it('narrows accept to PDF only when only the document MIME is passed', () => {
      render(<AttachmentPickerButton acceptMime={['application/pdf']} />);
      const input = screen.getByTestId('attachment-picker-input');
      if (!(input instanceof HTMLInputElement)) throw new Error('Expected HTMLInputElement');
      expect(input.accept).toBe('application/pdf');
      // aria-label adapts to reflect what the picker actually accepts.
      expect(screen.getByRole('button', { name: /attach a pdf/i })).toBeInTheDocument();
    });

    it('rejects a PDF dropped into an image-only picker via onError', async () => {
      const onError = vi.fn();
      const onAttachmentsChange = vi.fn();
      render(
        <AttachmentPickerButton
          acceptMime={['image/png', 'image/jpeg', 'image/gif', 'image/webp']}
          onAttachmentsChange={onAttachmentsChange}
          onError={onError}
        />
      );
      const input = screen.getByTestId('attachment-picker-input');
      if (!(input instanceof HTMLInputElement)) throw new Error('Expected HTMLInputElement');
      const pdf = makeFile('doc.pdf', 'application/pdf');
      Object.defineProperty(input, 'files', { value: [pdf], configurable: true });
      fireEvent.change(input);

      await waitFor(() => {
        expect(onError).toHaveBeenCalled();
        expect(onError.mock.calls.at(-1)?.[0]).toMatch(/unsupported file type/i);
      });
      // Allowed list in the error message should mention images, not PDF.
      expect(onError.mock.calls.at(-1)?.[0]).toMatch(/JPEG/i);
      // The bad attachment must not have leaked into the on-change payload.
      const lastChange = onAttachmentsChange.mock.calls.at(-1)?.[0] ?? [];
      expect(lastChange).toHaveLength(0);
    });
  });

  it('disabled prop disables the button', () => {
    render(<AttachmentPickerButton disabled />);
    const button = screen.getByRole('button', { name: /attach an image or pdf/i });
    expect(button).toBeDisabled();
  });

  it('fires onAttachmentsChange with an attachment after picking an image', async () => {
    const onAttachmentsChange = vi.fn();
    const user = userEvent.setup();

    render(<AttachmentPickerButton onAttachmentsChange={onAttachmentsChange} />);
    const input = screen.getByTestId('attachment-picker-input');
    const file = makeFile('photo.png', 'image/png');

    await user.upload(input, file);

    await waitFor(() => {
      const lastCall = onAttachmentsChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toHaveLength(1);
      expect(lastCall?.[0][0].name).toBe('photo.png');
      expect(lastCall?.[0][0].mediaType).toBe('image/png');
    });
  });

  it('renders a thumbnail entry with a remove button after a successful pick', async () => {
    const user = userEvent.setup();
    render(<AttachmentPickerButton />);
    const input = screen.getByTestId('attachment-picker-input');
    await user.upload(input, makeFile('photo.png', 'image/png'));

    await waitFor(() => {
      expect(screen.getByTestId('attachment-thumbnail-strip')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /remove photo\.png/i })).toBeInTheDocument();
    });
  });

  it('removes an entry when the per-attachment remove button is clicked', async () => {
    const onAttachmentsChange = vi.fn();
    const user = userEvent.setup();
    render(<AttachmentPickerButton onAttachmentsChange={onAttachmentsChange} />);
    const input = screen.getByTestId('attachment-picker-input');
    await user.upload(input, makeFile('photo.png', 'image/png'));

    await waitFor(() => screen.getByRole('button', { name: /remove photo\.png/i }));

    await user.click(screen.getByRole('button', { name: /remove photo\.png/i }));

    await waitFor(() => {
      const lastCall = onAttachmentsChange.mock.calls.at(-1);
      expect(lastCall?.[0]).toHaveLength(0);
    });
  });

  it('fires onError with an unsupported MIME', async () => {
    const onError = vi.fn();
    render(<AttachmentPickerButton onError={onError} />);
    const input = screen.getByTestId('attachment-picker-input');
    const file = makeFile('bad.exe', 'application/octet-stream');
    // userEvent.upload filters by the input's accept attribute, so an
    // unsupported MIME never reaches the change handler. Fire the
    // change event directly to exercise the hook's validation path.
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    fireEvent.change(input);

    await waitFor(() => {
      expect(onError).toHaveBeenCalled();
      expect(onError.mock.calls.at(-1)?.[0]).toMatch(/unsupported file type/i);
    });
  });

  it('controlsRef.current.clear() empties the thumbnail strip', async () => {
    const user = userEvent.setup();
    const controlsRef = createRef<{ clear: () => void }>() as React.MutableRefObject<{
      clear: () => void;
    } | null>;
    render(<AttachmentPickerButton controlsRef={controlsRef} />);
    const input = screen.getByTestId('attachment-picker-input');
    await user.upload(input, makeFile('photo.png', 'image/png'));
    await waitFor(() => screen.getByTestId('attachment-thumbnail-strip'));
    expect(controlsRef.current).not.toBeNull();
    controlsRef.current?.clear();
    await waitFor(() => {
      expect(screen.queryByTestId('attachment-thumbnail-strip')).not.toBeInTheDocument();
    });
  });
});
