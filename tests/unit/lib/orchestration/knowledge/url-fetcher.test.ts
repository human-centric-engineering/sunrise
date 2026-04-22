/**
 * Tests for `lib/orchestration/knowledge/url-fetcher.ts`
 *
 * Covers SSRF protection, size limits, content-type detection,
 * file name derivation, and error handling.
 *
 * @see lib/orchestration/knowledge/url-fetcher.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (declared before imports) ────────────────────────────────────────

vi.mock('@/lib/security/safe-url', () => ({
  checkSafeProviderUrl: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { fetchDocumentFromUrl } from '@/lib/orchestration/knowledge/url-fetcher';
import { checkSafeProviderUrl } from '@/lib/security/safe-url';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal fetch Response with controllable headers and body. */
function makeFetchResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  contentLength?: string | null;
  body?: string | Uint8Array;
}) {
  const {
    ok = true,
    status = 200,
    statusText = 'OK',
    contentType = 'text/plain',
    contentLength = null,
    body = 'hello world',
  } = options;

  const headers = new Map<string, string>();
  if (contentType !== null) headers.set('content-type', contentType);
  if (contentLength !== null) headers.set('content-length', contentLength);

  const bodyBytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;

  return {
    ok,
    status,
    statusText,
    headers: {
      get: (key: string) => headers.get(key.toLowerCase()) ?? null,
    },
    arrayBuffer: () => Promise.resolve(bodyBytes.buffer),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('fetchDocumentFromUrl', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: URL is safe
    vi.mocked(checkSafeProviderUrl).mockReturnValue({ ok: true });
  });

  // ── SSRF protection ─────────────────────────────────────────────────────

  it('throws when checkSafeProviderUrl returns ok: false', async () => {
    vi.mocked(checkSafeProviderUrl).mockReturnValue({
      ok: false,
      reason: 'private_ip',
      message: 'private address blocked',
    });

    await expect(fetchDocumentFromUrl('http://192.168.1.1/doc.txt')).rejects.toThrow('URL blocked');
  });

  it('does not call fetch when SSRF check fails', async () => {
    vi.mocked(checkSafeProviderUrl).mockReturnValue({ ok: false, message: 'blocked' });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(fetchDocumentFromUrl('http://10.0.0.1/doc.txt')).rejects.toThrow();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── HTTP error responses ────────────────────────────────────────────────

  it('throws when fetch response is not ok (404)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ ok: false, status: 404, statusText: 'Not Found' }) as unknown as Response
    );

    await expect(fetchDocumentFromUrl('https://example.com/missing.txt')).rejects.toThrow(
      'Fetch failed: HTTP 404 Not Found'
    );
  });

  // ── Content-length size limit ───────────────────────────────────────────

  it('throws when content-length header exceeds 50 MB', async () => {
    const overLimit = String(51 * 1024 * 1024); // 51 MB
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentLength: overLimit }) as unknown as Response
    );

    await expect(fetchDocumentFromUrl('https://example.com/big.txt')).rejects.toThrow(
      'Document too large'
    );
  });

  // ── Post-download size limit ────────────────────────────────────────────

  it('throws when downloaded body exceeds 50 MB even without content-length', async () => {
    const bigBody = new Uint8Array(51 * 1024 * 1024); // 51 MB
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentLength: null, body: bigBody }) as unknown as Response
    );

    await expect(fetchDocumentFromUrl('https://example.com/big.txt')).rejects.toThrow(
      'Document too large'
    );
  });

  // ── Successful fetch — file name from URL ───────────────────────────────

  it('returns FetchedDocument with fileName from URL path', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'application/pdf' }) as unknown as Response
    );

    const result = await fetchDocumentFromUrl('https://example.com/report.pdf');

    expect(result.fileName).toBe('report.pdf');
    expect(result.sourceUrl).toBe('https://example.com/report.pdf');
  });

  it('returns mimeType from content-type header (without charset)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'text/plain; charset=utf-8' }) as unknown as Response
    );

    const result = await fetchDocumentFromUrl('https://example.com/notes.txt');

    expect(result.mimeType).toBe('text/plain');
  });

  it('returns a Buffer as content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({
        body: 'document content',
        contentType: 'text/plain',
      }) as unknown as Response
    );

    const result = await fetchDocumentFromUrl('https://example.com/doc.txt');

    expect(Buffer.isBuffer(result.content)).toBe(true);
    expect(result.content.toString()).toBe('document content');
  });

  // ── File name derived from content-type ────────────────────────────────

  it('derives .pdf extension from application/pdf when URL has no extension', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'application/pdf' }) as unknown as Response
    );

    // URL path basename has no extension
    const result = await fetchDocumentFromUrl('https://example.com/documents/report');

    expect(result.fileName).toBe('report.pdf');
  });

  it('derives .txt extension from text/plain when URL has no extension', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'text/plain' }) as unknown as Response
    );

    const result = await fetchDocumentFromUrl('https://example.com/readme');

    expect(result.fileName).toBe('readme.txt');
  });

  it('derives .md extension from text/markdown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'text/markdown' }) as unknown as Response
    );

    const result = await fetchDocumentFromUrl('https://example.com/guide');

    expect(result.fileName).toBe('guide.md');
  });

  // ── Unsupported extension / type ────────────────────────────────────────

  it('throws when URL has unsupported extension (.exe)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'application/octet-stream' }) as unknown as Response
    );

    await expect(fetchDocumentFromUrl('https://example.com/malware.exe')).rejects.toThrow(
      'Unsupported file type'
    );
  });

  it('throws when content-type is unrecognised and URL has no extension', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'application/octet-stream' }) as unknown as Response
    );

    await expect(fetchDocumentFromUrl('https://example.com/unknownfile')).rejects.toThrow(
      'Cannot determine file type'
    );
  });

  // ── Supported extensions from URL ──────────────────────────────────────

  it('accepts .docx extension', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }) as unknown as Response
    );

    const result = await fetchDocumentFromUrl('https://example.com/doc.docx');

    expect(result.fileName).toBe('doc.docx');
    expect(result.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });

  it('accepts .epub extension', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'application/epub+zip' }) as unknown as Response
    );

    const result = await fetchDocumentFromUrl('https://example.com/book.epub');

    expect(result.fileName).toBe('book.epub');
  });

  // ── Null content-type ──────────────────────────────────────────────────

  it('throws when content-type is null and URL extension is unsupported', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: null }) as unknown as Response
    );

    await expect(fetchDocumentFromUrl('https://example.com/weirdfile')).rejects.toThrow(
      'Cannot determine file type'
    );
  });

  // ── sourceUrl round-trip ────────────────────────────────────────────────

  it('returns sourceUrl equal to the original URL', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeFetchResponse({ contentType: 'text/plain' }) as unknown as Response
    );

    const url = 'https://example.com/notes.txt';
    const result = await fetchDocumentFromUrl(url);

    expect(result.sourceUrl).toBe(url);
  });
});
