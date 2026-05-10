/**
 * Generic multipart body-size guard — unit tests.
 *
 * The transcribe and knowledge-document routes both consume this helper
 * with their own caps + error codes. This file covers the helper's
 * header semantics in isolation; route-level integration tests assert
 * the wiring (that `request.formData()` is never called when the guard
 * fires).
 *
 * @see lib/api/multipart-guard.ts
 */

import { describe, it, expect } from 'vitest';

import { enforceContentLengthCap } from '@/lib/api/multipart-guard';

function reqWithContentLength(value: string | null): Request {
  // `Content-Length` is a "forbidden header name" per the fetch spec, so
  // happy-dom / undici strip it when constructing a real `Request`. The
  // helper bypasses that with a duck-typed mock — the production code only
  // calls `request.headers.get(...)`.
  return {
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === 'content-length') return value;
        return null;
      },
    },
  } as unknown as Request;
}

const baseOptions = {
  maxBytes: 1024,
  errorCode: 'TEST_TOO_LARGE',
  errorMessage: 'Test body too large',
};

describe('enforceContentLengthCap', () => {
  it('passes through when Content-Length is absent', () => {
    expect(enforceContentLengthCap(reqWithContentLength(null), baseOptions)).toBeNull();
  });

  it('passes through when Content-Length is non-numeric', () => {
    expect(enforceContentLengthCap(reqWithContentLength('abc'), baseOptions)).toBeNull();
  });

  it('passes through when Content-Length is below maxBytes', () => {
    expect(enforceContentLengthCap(reqWithContentLength('512'), baseOptions)).toBeNull();
  });

  it('passes through when Content-Length is exactly maxBytes', () => {
    expect(enforceContentLengthCap(reqWithContentLength('1024'), baseOptions)).toBeNull();
  });

  it('returns 413 when Content-Length exceeds maxBytes', async () => {
    const response = enforceContentLengthCap(reqWithContentLength('1025'), baseOptions);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(413);
    const body = (await response!.json()) as {
      success: boolean;
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('TEST_TOO_LARGE');
    expect(body.error.message).toBe('Test body too large');
  });

  it('attaches caller-supplied details when rejecting', async () => {
    const response = enforceContentLengthCap(reqWithContentLength('99999999'), {
      ...baseOptions,
      details: { file: ['Maximum size is 1024 bytes'] },
    });
    const body = (await response!.json()) as {
      error: { details?: Record<string, unknown> };
    };
    expect(body.error.details).toEqual({ file: ['Maximum size is 1024 bytes'] });
  });

  it('omits details when not supplied', async () => {
    const response = enforceContentLengthCap(reqWithContentLength('99999999'), baseOptions);
    const body = (await response!.json()) as { error: { details?: unknown } };
    expect(body.error.details).toBeUndefined();
  });

  it('honours different caps for different callers (audio vs document)', () => {
    // Audio cap (~25 MB)
    const audio = enforceContentLengthCap(reqWithContentLength('30000000'), {
      maxBytes: 25 * 1024 * 1024 + 4096,
      errorCode: 'AUDIO_TOO_LARGE',
      errorMessage: 'Audio file exceeds size limit',
    });
    expect(audio?.status).toBe(413);

    // Same body size, document cap (50 MB) — passes
    const doc = enforceContentLengthCap(reqWithContentLength('30000000'), {
      maxBytes: 50 * 1024 * 1024 + 4096,
      errorCode: 'FILE_TOO_LARGE',
      errorMessage: 'File exceeds size limit',
    });
    expect(doc).toBeNull();
  });
});
