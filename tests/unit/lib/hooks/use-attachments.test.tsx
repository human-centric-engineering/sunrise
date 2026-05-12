import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { useAttachments } from '@/lib/hooks/use-attachments';
import { MAX_CHAT_ATTACHMENT_BASE64_CHARS } from '@/lib/validations/orchestration';

/**
 * Build a File-like object that resolves base64 deterministically via
 * a FileReader stub. jsdom ships a real FileReader implementation, but
 * for image MIMEs that the hook tries to wrap in `URL.createObjectURL`
 * we still need to stub the URL methods. Mock both before each test.
 */
function makeFile(name: string, type: string, size: number, content?: string): File {
  const text = content ?? 'x'.repeat(size);
  return new File([text], name, { type });
}

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    writable: true,
    value: vi.fn().mockImplementation((_b: Blob) => `blob:mock-${Math.random()}`),
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    writable: true,
    value: vi.fn(),
  });
});

describe('useAttachments', () => {
  it('starts with an empty attachments list and no error', () => {
    const { result } = renderHook(() => useAttachments());
    expect(result.current.attachments).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('attaches a valid PNG file and exposes it via payload()', async () => {
    const { result } = renderHook(() => useAttachments());
    const file = makeFile('screenshot.png', 'image/png', 100);
    await act(async () => {
      await result.current.attach([file]);
    });
    expect(result.current.attachments).toHaveLength(1);
    expect(result.current.attachments[0].attachment.name).toBe('screenshot.png');
    expect(result.current.attachments[0].attachment.mediaType).toBe('image/png');
    expect(result.current.attachments[0].attachment.data.length).toBeGreaterThan(0);
    expect(result.current.attachments[0].previewUrl).not.toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.payload()).toHaveLength(1);
  });

  it('attaches a PDF without an object-URL preview', async () => {
    const { result } = renderHook(() => useAttachments());
    const file = makeFile('doc.pdf', 'application/pdf', 100);
    await act(async () => {
      await result.current.attach([file]);
    });
    expect(result.current.attachments[0].previewUrl).toBeNull();
  });

  it('rejects an unsupported MIME and surfaces an error', async () => {
    const { result } = renderHook(() => useAttachments());
    const file = makeFile('bad.exe', 'application/octet-stream', 100);
    await act(async () => {
      await result.current.attach([file]);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.error).toMatch(/unsupported file type/i);
  });

  it('rejects more than 10 files in a single batch', async () => {
    const { result } = renderHook(() => useAttachments());
    const files = Array.from({ length: 11 }, (_, i) => makeFile(`f${i}.png`, 'image/png', 10));
    await act(async () => {
      await result.current.attach(files);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.error).toMatch(/at most 10/i);
  });

  it('removes an attachment by id and clears object URL', async () => {
    const { result } = renderHook(() => useAttachments());
    const file = makeFile('a.png', 'image/png', 50);
    await act(async () => {
      await result.current.attach([file]);
    });
    const id = result.current.attachments[0].id;
    act(() => {
      result.current.remove(id);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
  });

  it('clear() removes all attachments and revokes all object URLs', async () => {
    const { result } = renderHook(() => useAttachments());
    const files = [makeFile('a.png', 'image/png', 50), makeFile('b.png', 'image/png', 50)];
    await act(async () => {
      await result.current.attach(files);
    });
    expect(result.current.attachments).toHaveLength(2);
    act(() => {
      result.current.clear();
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(
      (URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBeGreaterThanOrEqual(2);
  });

  it('rejects a per-attachment payload that overshoots the size cap', async () => {
    const { result } = renderHook(() => useAttachments());
    // Construct a payload that, after base64 encoding, exceeds the cap.
    // Use a binary that base64 to > MAX_CHAT_ATTACHMENT_BASE64_CHARS chars.
    const rawBytes = Math.ceil((MAX_CHAT_ATTACHMENT_BASE64_CHARS / 4) * 3) + 100;
    const file = makeFile('huge.png', 'image/png', rawBytes);
    await act(async () => {
      await result.current.attach([file]);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.error).toMatch(/5 MB limit/i);
  });

  it('respects a narrowed allowedMimes — rejects a PDF when only images are allowed', async () => {
    const { result } = renderHook(() =>
      useAttachments({ allowedMimes: ['image/png', 'image/jpeg'] })
    );
    const pdf = makeFile('doc.pdf', 'application/pdf', 100);
    await act(async () => {
      await result.current.attach([pdf]);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.error).toMatch(/unsupported file type/i);
    // The narrowed error message should mention the image-only allowlist,
    // not list PDF as an option.
    expect(result.current.error).not.toMatch(/PDF/);
    expect(result.current.error).toMatch(/JPEG/);
  });

  it('rejects when a single batch overshoots the combined cap', async () => {
    const { result } = renderHook(() => useAttachments());
    // Each file's raw text is 5_000_000 chars → base64 ~6_666_668
    // chars (under the 7_500_000 per-item cap). Six of those total
    // ~40M base64 chars, well over the 37.5M combined cap. So each
    // per-item check passes; only the combined-size superRefine trips.
    const perFile = 5_000_000;
    const files = Array.from({ length: 6 }, (_, i) => makeFile(`f${i}.png`, 'image/png', perFile));
    await act(async () => {
      await result.current.attach(files);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.error).toMatch(/combined attachment size/i);
  });

  it('clears the error when a removal happens after a failed attach', async () => {
    const { result } = renderHook(() => useAttachments());
    // First successful attach.
    await act(async () => {
      await result.current.attach([makeFile('a.png', 'image/png', 50)]);
    });
    expect(result.current.attachments).toHaveLength(1);
    const id = result.current.attachments[0].id;
    // Then trigger an error.
    await act(async () => {
      await result.current.attach([makeFile('bad.exe', 'application/octet-stream', 10)]);
    });
    expect(result.current.error).toMatch(/unsupported/i);
    // remove() should clear the lingering error so subsequent attempts
    // start with a clean slate.
    act(() => {
      result.current.remove(id);
    });
    expect(result.current.error).toBeNull();
  });

  it('payload() returns the bare ChatAttachment objects (no entry metadata)', async () => {
    const { result } = renderHook(() => useAttachments());
    await act(async () => {
      await result.current.attach([makeFile('x.png', 'image/png', 50)]);
    });
    const payload = result.current.payload();
    expect(payload).toHaveLength(1);
    expect(Object.keys(payload[0]).sort()).toEqual(['data', 'mediaType', 'name']);
  });

  it('rejects an empty file (base64 length zero) with an explicit message', async () => {
    const { result } = renderHook(() => useAttachments());
    const empty = new File([], 'empty.png', { type: 'image/png' });
    await act(async () => {
      await result.current.attach([empty]);
    });
    expect(result.current.attachments).toHaveLength(0);
    expect(result.current.error).toMatch(/empty/i);
  });

  it('surfaces a FileReader error through the error channel', async () => {
    // Force FileReader.readAsDataURL to fail so the reject(reader.error)
    // branch runs. Restore at the end of the test.
    const RealFileReader = globalThis.FileReader;
    class BrokenFileReader {
      onerror: ((this: FileReader, ev: ProgressEvent) => void) | null = null;
      onload: ((this: FileReader, ev: ProgressEvent) => void) | null = null;
      readyState = 0;
      result: string | ArrayBuffer | null = null;
      error: DOMException | null = null;
      readAsDataURL() {
        // Microtask hop so the consumer can attach handlers first.
        queueMicrotask(() => {
          this.error = new DOMException('disk read failed', 'NotReadableError');
          // FileReader's onerror gets called with `this` bound and
          // a fake ProgressEvent.
          this.onerror?.call(this as unknown as FileReader, new Event('error') as ProgressEvent);
        });
      }
      readAsArrayBuffer() {}
      readAsText() {}
      readAsBinaryString() {}
      abort() {}
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
    }
    // @ts-expect-error — replace with broken impl for this test only
    globalThis.FileReader = BrokenFileReader;
    try {
      const { result } = renderHook(() => useAttachments());
      const file = new File(['x'], 'broken.png', { type: 'image/png' });
      await act(async () => {
        await result.current.attach([file]);
      });
      expect(result.current.attachments).toHaveLength(0);
      // The catch block prefixes the error with the filename and the
      // reader's error message.
      expect(result.current.error).toMatch(/broken\.png/);
      expect(result.current.error).toMatch(/disk read failed|failed to read/i);
    } finally {
      globalThis.FileReader = RealFileReader;
    }
  });

  it('describes allowed types accurately when only PDFs are permitted', async () => {
    // Hits the `if (hasPdf) return 'PDF'` branch of `describeAllowed`.
    const { result } = renderHook(() => useAttachments({ allowedMimes: ['application/pdf'] }));
    await act(async () => {
      await result.current.attach([makeFile('a.png', 'image/png', 10)]);
    });
    expect(result.current.error).toMatch(/Allowed: PDF/);
  });

  it('describes allowed types accurately when allowedMimes is empty', async () => {
    // Hits the `return 'none'` branch of `describeAllowed`.
    const { result } = renderHook(() => useAttachments({ allowedMimes: [] }));
    await act(async () => {
      await result.current.attach([makeFile('a.png', 'image/png', 10)]);
    });
    expect(result.current.error).toMatch(/Allowed: none/);
  });

  it('revokes object URLs on unmount cleanup', async () => {
    const { result, unmount } = renderHook(() => useAttachments());
    await act(async () => {
      await result.current.attach([makeFile('a.png', 'image/png', 50)]);
    });
    const beforeUnmount = (URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    unmount();
    const afterUnmount = (URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length;
    // At least one revoke fired during teardown (mounted state had one
    // image, the unmount effect should clear it).
    expect(afterUnmount).toBeGreaterThan(beforeUnmount);
  });
});
