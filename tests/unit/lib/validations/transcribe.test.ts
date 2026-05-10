/**
 * Transcribe upload validator — boundary + abuse coverage.
 *
 * The validator runs on every transcribe request (admin and embed) so its
 * acceptance and rejection rules effectively define the public contract
 * for what audio reaches the provider. This file stress-tests the edges:
 *
 * - MIME case-sensitivity and codec parameters
 * - File size boundaries (exact 25 MB, 25 MB + 1 byte, 0 bytes)
 * - agentId length / type boundaries
 * - Language code regex including 3-char ISO 639-3 codes and locale tags
 * - Audio field absence vs. wrong type (string instead of File)
 *
 * Each rejection asserts the standard error envelope shape so the route
 * handlers can forward the response without rewrapping.
 */

import { describe, it, expect } from 'vitest';

import {
  ALLOWED_AUDIO_PREFIXES,
  MAX_REQUEST_BYTES,
  MAX_TRANSCRIBE_BYTES,
  enforceContentLengthCap,
  validateTranscribeUpload,
} from '@/lib/validations/transcribe';

function reqWithContentLength(value: string | null): Request {
  // Note: `Content-Length` is a "forbidden header name" per the fetch spec,
  // so happy-dom / undici strip it when constructing a real `Request`. The
  // helper bypasses that with a duck-typed mock — the production code only
  // calls `request.headers.get(...)`, which this satisfies.
  const headers = new Headers();
  if (value !== null) headers.set('x-mock-content-length', value);
  return {
    headers: {
      get(name: string): string | null {
        if (name.toLowerCase() === 'content-length') {
          return headers.get('x-mock-content-length');
        }
        return headers.get(name);
      },
    },
  } as unknown as Request;
}

function fd(
  fields: Partial<{ audio: File | string | null; agentId: string | null; language: string | null }>
): FormData {
  const form = new FormData();
  if (fields.audio instanceof File) form.set('audio', fields.audio);
  else if (typeof fields.audio === 'string') form.set('audio', fields.audio);
  if (typeof fields.agentId === 'string') form.set('agentId', fields.agentId);
  if (typeof fields.language === 'string') form.set('language', fields.language);
  return form;
}

function audioFile(opts: { type?: string; size?: number; name?: string } = {}): File {
  const type = opts.type ?? 'audio/webm';
  const size = opts.size ?? 64;
  const bytes = new Uint8Array(size);
  return new File([bytes], opts.name ?? 'voice.webm', { type });
}

async function readError(result: ReturnType<typeof validateTranscribeUpload>) {
  if (result.ok) throw new Error('expected validation failure');
  return JSON.parse(await result.response.text()) as {
    success: boolean;
    error: { code: string; details?: Record<string, unknown> };
  };
}

describe('validateTranscribeUpload — audio field', () => {
  it('returns MISSING_AUDIO when no audio field is present', async () => {
    const result = validateTranscribeUpload(fd({ agentId: 'a' }));
    const body = await readError(result);
    expect(body.error.code).toBe('MISSING_AUDIO');
  });

  it('returns MISSING_AUDIO when audio field is a string (not a File)', async () => {
    // Browsers can submit FormData with text fields named `audio`. The
    // validator must reject anything that isn't a File so a malicious
    // client can't send arbitrary text and have it round-trip.
    const result = validateTranscribeUpload(fd({ audio: 'not-a-file', agentId: 'a' }));
    const body = await readError(result);
    expect(body.error.code).toBe('MISSING_AUDIO');
  });

  it('returns AUDIO_EMPTY for a 0-byte file', async () => {
    const result = validateTranscribeUpload(fd({ audio: audioFile({ size: 0 }), agentId: 'a' }));
    const body = await readError(result);
    expect(body.error.code).toBe('AUDIO_EMPTY');
  });
});

describe('validateTranscribeUpload — size boundaries', () => {
  it('accepts a file exactly at MAX_TRANSCRIBE_BYTES', () => {
    const result = validateTranscribeUpload(
      fd({ audio: audioFile({ size: MAX_TRANSCRIBE_BYTES }), agentId: 'a' })
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a file at MAX_TRANSCRIBE_BYTES + 1 byte', async () => {
    const result = validateTranscribeUpload(
      fd({ audio: audioFile({ size: MAX_TRANSCRIBE_BYTES + 1 }), agentId: 'a' })
    );
    const body = await readError(result);
    expect(body.error.code).toBe('AUDIO_TOO_LARGE');
  });
});

describe('validateTranscribeUpload — MIME matching', () => {
  it.each([
    'audio/webm',
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mpeg',
    'audio/wav',
    'audio/x-wav',
    'audio/ogg',
    'audio/ogg;codecs=vorbis',
  ])('accepts %s', (type) => {
    const result = validateTranscribeUpload(fd({ audio: audioFile({ type }), agentId: 'a' }));
    expect(result.ok).toBe(true);
  });

  it('matches MIME prefix case-insensitively (Safari sometimes uppercases)', () => {
    const result = validateTranscribeUpload(
      fd({ audio: audioFile({ type: 'AUDIO/MP4' }), agentId: 'a' })
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ['', 'empty MIME'],
    ['application/octet-stream', 'generic binary'],
    ['video/mp4', 'video container'],
    ['text/plain', 'text'],
    ['audio', 'malformed (no slash)'],
    [' audio/webm', 'leading whitespace'],
    ['xaudio/webm', 'prefix with extra chars'],
  ])('rejects %s (%s)', async (type) => {
    const result = validateTranscribeUpload(fd({ audio: audioFile({ type }), agentId: 'a' }));
    const body = await readError(result);
    expect(body.error.code).toBe('AUDIO_INVALID_TYPE');
    expect(body.error.details?.received).toEqual([type || '<empty>']);
  });

  it('exposes the allow-list in error details so clients can self-correct', async () => {
    const result = validateTranscribeUpload(
      fd({ audio: audioFile({ type: 'video/quicktime' }), agentId: 'a' })
    );
    const body = await readError(result);
    expect(body.error.details?.audio).toEqual([
      `Allowed prefixes: ${ALLOWED_AUDIO_PREFIXES.join(', ')}`,
    ]);
  });
});

describe('validateTranscribeUpload — agentId boundaries', () => {
  it('rejects when agentId is missing', async () => {
    const result = validateTranscribeUpload(fd({ audio: audioFile() }));
    const body = await readError(result);
    expect(body.error.code).toBe('MISSING_AGENT_ID');
  });

  it('rejects an empty agentId string', async () => {
    const result = validateTranscribeUpload(fd({ audio: audioFile(), agentId: '' }));
    const body = await readError(result);
    expect(body.error.code).toBe('MISSING_AGENT_ID');
  });

  it('accepts a 64-char agentId (boundary)', () => {
    const result = validateTranscribeUpload(fd({ audio: audioFile(), agentId: 'a'.repeat(64) }));
    expect(result.ok).toBe(true);
  });

  it('rejects a 65-char agentId (boundary + 1)', async () => {
    const result = validateTranscribeUpload(fd({ audio: audioFile(), agentId: 'a'.repeat(65) }));
    const body = await readError(result);
    expect(body.error.code).toBe('MISSING_AGENT_ID');
  });
});

describe('validateTranscribeUpload — language hint', () => {
  it('omits language from the result when not provided', () => {
    const result = validateTranscribeUpload(fd({ audio: audioFile(), agentId: 'a' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.language).toBeUndefined();
  });

  it.each(['en', 'es', 'EN', 'pt-BR', 'zh-Hans', 'mul'])('accepts %s', (lang) => {
    const result = validateTranscribeUpload(
      fd({ audio: audioFile(), agentId: 'a', language: lang })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.language).toBe(lang);
  });

  it.each([
    ['', 'empty'],
    ['e', 'too short'],
    ['english', 'word'],
    ['en_US', 'underscore (not hyphen)'],
    ['en-', 'trailing hyphen'],
    ['EVIL$$', 'special chars'],
    ['en US', 'whitespace'],
    ['<script>', 'XSS attempt'],
  ])('rejects %s (%s)', async (lang) => {
    const result = validateTranscribeUpload(
      fd({ audio: audioFile(), agentId: 'a', language: lang })
    );
    const body = await readError(result);
    expect(body.error.code).toBe('INVALID_LANGUAGE');
  });
});

describe('enforceContentLengthCap — pre-parse body-size guard', () => {
  it('passes through when no Content-Length header is set', () => {
    // Some proxies strip Content-Length for chunked transfer encoding; the
    // post-parse `file.size` check is the backstop in that case.
    expect(enforceContentLengthCap(reqWithContentLength(null))).toBeNull();
  });

  it('passes through when Content-Length is non-numeric', () => {
    // A header glitch shouldn't reject good clients — fall through to the
    // post-parse check.
    expect(enforceContentLengthCap(reqWithContentLength('abc'))).toBeNull();
  });

  it('passes through when Content-Length is below MAX_REQUEST_BYTES', () => {
    expect(enforceContentLengthCap(reqWithContentLength('1024'))).toBeNull();
  });

  it('passes through when Content-Length is exactly MAX_REQUEST_BYTES', () => {
    expect(enforceContentLengthCap(reqWithContentLength(String(MAX_REQUEST_BYTES)))).toBeNull();
  });

  it('returns 413 AUDIO_TOO_LARGE when Content-Length exceeds MAX_REQUEST_BYTES', async () => {
    const response = enforceContentLengthCap(reqWithContentLength(String(MAX_REQUEST_BYTES + 1)));
    expect(response).not.toBeNull();
    expect(response?.status).toBe(413);
    const body = (await response!.json()) as {
      success: boolean;
      error: { code: string; details?: Record<string, unknown> };
    };
    expect(body.error.code).toBe('AUDIO_TOO_LARGE');
    expect(body.error.details?.audio).toEqual([`Maximum size is ${MAX_TRANSCRIBE_BYTES} bytes`]);
  });

  it('returns 413 for blatantly oversized claims (DoS attempt)', async () => {
    // 1 GB body — what an attacker would set in a heap-exhaustion attempt.
    const response = enforceContentLengthCap(reqWithContentLength('1073741824'));
    expect(response?.status).toBe(413);
  });

  it('MAX_REQUEST_BYTES has at least 4 KB headroom over MAX_TRANSCRIBE_BYTES', () => {
    // A legitimate 25 MB upload's body is the file plus multipart overhead
    // (boundaries + form-field headers). The headroom must absorb that
    // overhead so we never reject a within-spec audio file.
    expect(MAX_REQUEST_BYTES).toBeGreaterThanOrEqual(MAX_TRANSCRIBE_BYTES + 4 * 1024);
  });
});

describe('validateTranscribeUpload — happy path', () => {
  it('returns parsed file, agentId, and language for a well-formed body', () => {
    const file = audioFile({ type: 'audio/webm;codecs=opus', size: 1024, name: 'voice.webm' });
    const result = validateTranscribeUpload(
      fd({ audio: file, agentId: 'agent-1', language: 'en' })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.file).toBe(file);
      expect(result.value.agentId).toBe('agent-1');
      expect(result.value.language).toBe('en');
    }
  });
});
