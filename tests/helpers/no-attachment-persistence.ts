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
