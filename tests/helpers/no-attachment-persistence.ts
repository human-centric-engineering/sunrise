/**
 * Test helper: assert image / PDF attachment bytes never reach the database.
 *
 * Mirrors `no-audio-persistence.ts` for the image+PDF chat-input feature.
 * Used by the chat-stream regression tests to lock in the audit invariant
 * that the streaming handler MUST NOT persist attachment bytes — only the
 * user's text becomes an `AiMessage`, and only an aggregate cost row goes
 * to `AiCostLog`.
 *
 * The helper walks every recorded mock call's argument tree looking for:
 *
 *   1. Direct binary types (Buffer, Uint8Array, Blob, ArrayBuffer).
 *   2. Object keys that look like attachment-shaped fields — catches the
 *      case where a future contributor stuffs base64 image bytes into
 *      JSON metadata "for analytics" or "for replay".
 *   3. **Values that look like a base64 payload, whatever the key is
 *      called.** (2) alone was not enough and was demonstrably bypassable:
 *      attachments in this codebase are `{ name, mediaType, data }`, and
 *      `data` is not an attachment-shaped name in any useful sense — a
 *      mutation persisting `metadata.files[].data` passed the key check
 *      cleanly while writing the whole PNG to the database. A key list can
 *      only ever enumerate the names someone already thought of; the byte
 *      shape is the property that does not depend on naming.
 *
 * Bounded recursion (depth cap 8) prevents circular references from
 * hanging the test runner.
 */

import { expect, type MockInstance } from 'vitest';

const SUSPECT_KEYS = new Set([
  'attachment',
  'attachments',
  'attachmentbytes',
  'attachmentdata',
  'imagebytes',
  'imagedata',
  'imageblob',
  'imageb64',
  'pdfbytes',
  'pdfdata',
  'pdfblob',
  'pdfb64',
  'filebytes',
  'fileblob',
  'rawbytes',
  'base64data',
]);

const MAX_DEPTH = 8;

/**
 * Minimum length before a base64-looking string is treated as a payload.
 *
 * Sized to sit above the things that legitimately travel in metadata and
 * happen to be base64-alphabet — cuids (~25), UUIDs (36, and disqualified by
 * their hyphens anyway), model slugs, trace ids — and well below any real
 * attachment. The smallest possible valid PNG is ~68 bytes base64; a 1x1
 * transparent GIF is ~62. 256 leaves generous headroom on both sides.
 */
const BASE64_PAYLOAD_MIN_LENGTH = 256;

/** Strict base64 alphabet with optional padding, no whitespace. */
const BASE64_RE = /^[A-Za-z0-9+/]{256,}={0,2}$/;

/**
 * Base64 prefixes of the magic bytes for formats this feature accepts.
 * A short string carrying one of these is still a smoking gun, so these are
 * checked without the length floor.
 */
const MAGIC_PREFIXES = [
  'iVBORw0KGgo', // PNG
  'JVBERi0', // PDF  (%PDF-)
  '/9j/', // JPEG
  'R0lGOD', // GIF
  'UklGR', // WEBP (RIFF)
];

function looksLikeBase64Payload(value: string): string | null {
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
          reason: `attachment-shaped key "${key}"`,
        });
      }
      walk(child, `${path}.${key}`, depth + 1, findings);
    }
  }
}

/**
 * Assert that none of the recorded calls on `mock` carry attachment
 * bytes (binary types) or attachment-shaped property keys in their
 * arguments. Pass the mocked function, e.g. `prisma.aiMessage.create`.
 */
export function assertNoAttachmentPersistence(
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
      `${label} received an argument carrying attachment data — chat routes ` +
        `must not persist image / PDF bytes. Findings:\n${formatted}`
    );
  }
}
