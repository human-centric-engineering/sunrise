/**
 * Transcribe Upload Validation
 *
 * Shared multipart validation for the admin and embed transcribe
 * endpoints. The endpoints share the same body shape — a `file`
 * field carrying audio bytes plus a string `agentId` and optional
 * `language` — so the parsing + size + MIME checks live here once.
 *
 * Returns a discriminated union so the route handlers can return a
 * pre-built error response on failure without re-implementing the
 * standard error envelope.
 */

import { errorResponse } from '@/lib/api/responses';

/** 25 MB cap — matches OpenAI Whisper's request limit. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;

/**
 * Maximum body size accepted before parsing. Adds a small headroom over
 * `MAX_TRANSCRIBE_BYTES` to allow for multipart boundaries plus the
 * `agentId` and `language` form fields. The pre-parse guard rejects with
 * `AUDIO_TOO_LARGE` when the `Content-Length` header exceeds this value.
 */
export const MAX_REQUEST_BYTES = MAX_TRANSCRIBE_BYTES + 4 * 1024;

/**
 * Enforce the body-size cap from the `Content-Length` header before
 * parsing. Returns a 413 `Response` to short-circuit the handler, or
 * `null` to pass through.
 *
 * Why pre-parse: `request.formData()` materialises the entire multipart
 * body in memory before the validator's `file.size` check runs. On
 * self-hosted Node a malicious admin could send an arbitrarily large
 * body and exhaust the heap. This guard catches the common case
 * (well-formed clients always send `Content-Length`) cheaply.
 *
 * Why headroom semantics:
 *   - Missing `Content-Length` → pass through. Some proxies strip the
 *     header on chunked transfer encoding; the post-parse `file.size`
 *     check is the backstop in that case.
 *   - Non-numeric `Content-Length` → pass through. Don't reject good
 *     clients on a header glitch.
 *   - Numeric and over cap → reject with 413 `AUDIO_TOO_LARGE` (same
 *     code the post-parse path uses, so client error mapping is
 *     unchanged).
 */
export function enforceContentLengthCap(request: Request): Response | null {
  const header = request.headers.get('content-length');
  if (!header) return null;
  const length = Number.parseInt(header, 10);
  if (!Number.isFinite(length)) return null;
  if (length <= MAX_REQUEST_BYTES) return null;
  return errorResponse('Audio file exceeds size limit', {
    code: 'AUDIO_TOO_LARGE',
    status: 413,
    details: { audio: [`Maximum size is ${MAX_TRANSCRIBE_BYTES} bytes`] },
  });
}

/**
 * Allowed audio MIME types.
 *
 * We accept the formats every common in-browser `MediaRecorder` produces:
 *
 *   - Chrome / Firefox desktop & Android  → `audio/webm` (Opus)
 *   - Safari (macOS / iOS)                 → `audio/mp4` (AAC)
 *   - Older codecs / desktop apps         → `audio/mpeg`, `audio/wav`, `audio/ogg`
 *
 * The check is prefix-based so codec parameters (e.g. `audio/webm;codecs=opus`)
 * still match. Anything outside this set is rejected with `AUDIO_INVALID_TYPE`.
 */
export const ALLOWED_AUDIO_PREFIXES = [
  'audio/webm',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
] as const;

/** ISO 639-1 language hint pattern (e.g. `en`, `es`, `pt-BR`). */
const LANGUAGE_PATTERN = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/;

export interface TranscribeUploadOk {
  ok: true;
  value: {
    file: File;
    agentId: string;
    language?: string;
  };
}

export interface TranscribeUploadErr {
  ok: false;
  response: Response;
}

export type TranscribeUploadResult = TranscribeUploadOk | TranscribeUploadErr;

function isAllowedAudioMime(type: string): boolean {
  if (!type) return false;
  return ALLOWED_AUDIO_PREFIXES.some((prefix) => type.toLowerCase().startsWith(prefix));
}

/**
 * Parse + validate a transcribe-endpoint multipart body. Returns a
 * `{ ok: true, value }` on success or `{ ok: false, response }` carrying
 * the appropriate 400/413/415 error response on failure. Callers should
 * forward `response` directly.
 */
export function validateTranscribeUpload(formData: FormData): TranscribeUploadResult {
  const file = formData.get('audio');
  if (!(file instanceof File)) {
    return {
      ok: false,
      response: errorResponse('Missing audio field', {
        code: 'MISSING_AUDIO',
        status: 400,
        details: { audio: ['An audio file must be supplied in the `audio` form field'] },
      }),
    };
  }

  if (file.size === 0) {
    return {
      ok: false,
      response: errorResponse('Audio file is empty', {
        code: 'AUDIO_EMPTY',
        status: 400,
      }),
    };
  }

  if (file.size > MAX_TRANSCRIBE_BYTES) {
    return {
      ok: false,
      response: errorResponse('Audio file exceeds size limit', {
        code: 'AUDIO_TOO_LARGE',
        status: 413,
        details: { audio: [`Maximum size is ${MAX_TRANSCRIBE_BYTES} bytes`] },
      }),
    };
  }

  if (!isAllowedAudioMime(file.type)) {
    return {
      ok: false,
      response: errorResponse('Unsupported audio MIME type', {
        code: 'AUDIO_INVALID_TYPE',
        status: 415,
        details: {
          audio: [`Allowed prefixes: ${ALLOWED_AUDIO_PREFIXES.join(', ')}`],
          received: [file.type || '<empty>'],
        },
      }),
    };
  }

  const agentIdRaw = formData.get('agentId');
  if (typeof agentIdRaw !== 'string' || agentIdRaw.length === 0 || agentIdRaw.length > 64) {
    return {
      ok: false,
      response: errorResponse('Missing or invalid agentId field', {
        code: 'MISSING_AGENT_ID',
        status: 400,
      }),
    };
  }

  const languageRaw = formData.get('language');
  let language: string | undefined;
  if (languageRaw !== null) {
    if (typeof languageRaw !== 'string' || !LANGUAGE_PATTERN.test(languageRaw)) {
      return {
        ok: false,
        response: errorResponse('Invalid language field', {
          code: 'INVALID_LANGUAGE',
          status: 400,
          details: { language: ['Expected an ISO 639-1 code, e.g. "en"'] },
        }),
      };
    }
    language = languageRaw;
  }

  return {
    ok: true,
    value:
      language !== undefined
        ? { file, agentId: agentIdRaw, language }
        : { file, agentId: agentIdRaw },
  };
}
