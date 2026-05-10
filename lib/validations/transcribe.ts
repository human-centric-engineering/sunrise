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
