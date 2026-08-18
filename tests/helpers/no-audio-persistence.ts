/**
 * Test helper: assert audio bytes never reach the database.
 *
 * Used by the transcribe-route regression tests to lock in the audit
 * invariant that the request handlers MUST NOT persist audio. The
 * helper walks every recorded mock call's arguments looking for:
 *
 *   1. Direct binary types (Buffer, Uint8Array, Blob, ArrayBuffer).
 *   2. Object keys that look like audio-shaped fields — see `SUSPECT_KEYS`
 *      below for the actual list, which is `audio`-prefixed plus `rawAudio`,
 *      `recording` and `voiceBytes`. It does NOT include bare `bytes` or
 *      `data`, and an earlier version of this comment claimed it did — the
 *      exact false guarantee that let a PNG through the sibling guard (#626).
 *      Rule (3) is what covers the keys nobody enumerated.
 *   3. **Values that look like a base64 payload, whatever the key is
 *      called.** A key list can only enumerate the names someone already
 *      thought of; the byte shape does not depend on naming. Normalises
 *      `data:` URIs, base64url and MIME line-wrapping first, so the same
 *      bytes are caught whichever layer produced them.
 *
 * The helper is permissive about depth (recursively walks objects and
 * arrays) but bounded — it caps recursion at 8 levels so a circular
 * reference can't hang the test runner.
 */

import { expect, type MockInstance } from 'vitest';

const SUSPECT_KEYS = new Set([
  'audio',
  'audioblob',
  'audiobytes',
  'audiocontent',
  'audiodata',
  'audiosrc',
  'audiourl',
  'rawaudio',
  'recording',
  'voicebytes',
]);

const MAX_DEPTH = 8;

/**
 * Minimum length before a base64-looking string is treated as a payload.
 * See the sibling rationale in `no-attachment-persistence.ts`: a key list can
 * only enumerate names someone already thought of, so the byte shape is the
 * property that does not depend on naming. 256 sits above cuids, UUIDs, model
 * slugs and trace ids, and far below any real recording.
 */
const BASE64_PAYLOAD_MIN_LENGTH = 256;

/**
 * Strict base64 alphabet with optional padding. The length floor is enforced
 * by `BASE64_PAYLOAD_MIN_LENGTH` in the caller, NOT baked in here — a `{256,}`
 * quantifier duplicating the constant made lowering it a silent no-op.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Strip the wrappers a base64 payload picks up in transit, so the checks below
 * see the same bytes whatever layer produced them. All three occur in this
 * codebase's own audio path:
 *
 *   - `data:<mime>;base64,` — what `FileReader.readAsDataURL` returns
 *     (`lib/hooks/use-attachments.ts` strips it; `openai-compatible.ts`
 *     re-adds it when formatting for the provider). Without this, persisting
 *     either the raw reader output or the provider-formatted part evades the
 *     guard entirely, because `:` `;` `,` are outside the base64 alphabet.
 *   - base64url `-` / `_` — URL-safe variants of `+` / `/`.
 *   - newlines — MIME base64 is chunked at 76 chars.
 */
function normaliseBase64(value: string): string {
  return value
    .replace(/^data:[^,]{0,120},/i, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
}

/**
 * Base64 prefixes of the magic bytes for audio container formats. A short
 * string carrying one of these is a smoking gun, so these skip the length
 * floor. `UklGR` is RIFF, which covers WAV.
 */
const MAGIC_PREFIXES = [
  'UklGR', // RIFF / WAV
  'SUQz', // ID3  / MP3
  'T2dnUw', // OggS / OGG, Opus
  'GkXf', // EBML / WebM, Matroska
  '//uQ', // MPEG frame sync / bare MP3
];

function looksLikeBase64Payload(raw: string): string | null {
  const value = normaliseBase64(raw);
  for (const prefix of MAGIC_PREFIXES) {
    if (value.startsWith(prefix)) {
      return `base64 payload with ${prefix} magic-byte prefix`;
    }
  }
  if (value.length >= BASE64_PAYLOAD_MIN_LENGTH && BASE64_RE.test(value)) {
    return `base64-shaped string of ${value.length} chars`;
  }
  return null;
}

interface Finding {
  callIndex: number;
  argIndex: number;
  path: string;
  reason: string;
}

function isBinary(value: unknown): boolean {
  if (value instanceof Uint8Array) return true;
  if (value instanceof ArrayBuffer) return true;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  return false;
}

function walk(value: unknown, path: string, depth: number, findings: Finding[]): void {
  if (depth > MAX_DEPTH) return;
  if (value === null || value === undefined) return;

  if (isBinary(value)) {
    findings.push({ callIndex: -1, argIndex: -1, path, reason: 'binary value' });
    return;
  }

  if (typeof value === 'string') {
    const reason = looksLikeBase64Payload(value);
    if (reason) {
      findings.push({ callIndex: -1, argIndex: -1, path, reason });
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], `${path}[${i}]`, depth + 1, findings);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (SUSPECT_KEYS.has(key.toLowerCase())) {
        findings.push({
          callIndex: -1,
          argIndex: -1,
          path: `${path}.${key}`,
          reason: `audio-shaped key "${key}"`,
        });
      }
      walk(child, `${path}.${key}`, depth + 1, findings);
    }
  }
}

/**
 * Assert that none of the recorded calls on `mock` carry audio bytes
 * (binary types) or audio-shaped property keys in their arguments.
 *
 * Pass the mocked function, e.g. `prisma.aiMessage.create`. The helper
 * walks every call's argument tree and fails the test with a precise
 * path on any finding so a future regression points straight at the
 * offending key.
 */
export function assertNoAudioPersistence(
  mock: MockInstance | { mock: { calls: unknown[][] } },
  label: string
): void {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  const findings: Finding[] = [];

  for (let callIndex = 0; callIndex < calls.length; callIndex++) {
    const args = calls[callIndex];
    if (!args) continue;
    for (let argIndex = 0; argIndex < args.length; argIndex++) {
      const local: Finding[] = [];
      walk(args[argIndex], `arg${argIndex}`, 0, local);
      for (const f of local) findings.push({ ...f, callIndex, argIndex });
    }
  }

  if (findings.length > 0) {
    const formatted = findings
      .map((f) => `  - call ${f.callIndex} ${f.path}: ${f.reason}`)
      .join('\n');
    expect.fail(
      `${label} received an argument carrying audio data — the transcribe route ` +
        `must not persist audio bytes. Findings:\n${formatted}`
    );
  }
}
