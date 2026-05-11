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
});
