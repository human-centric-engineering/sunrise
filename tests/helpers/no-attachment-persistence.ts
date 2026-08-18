/**
 * Test helper: assert image / PDF attachment bytes never reach the database.
 *
 * Used by the chat-stream regression tests to lock in the audit invariant that
 * the streaming handler MUST NOT persist attachment bytes — only the user's
 * text becomes an `AiMessage`, and only an aggregate cost row goes to
 * `AiCostLog`.
 *
 * The detection logic, the reasoning behind it, and the deliberate limits of
 * what it can catch all live in `no-binary-persistence.ts`. Read that before
 * changing anything here.
 *
 * @see tests/helpers/no-binary-persistence.ts
 * @see tests/helpers/no-audio-persistence.ts
 */

import { assertNoBinaryPersistence, type GuardSpec } from '@/tests/helpers/no-binary-persistence';

/**
 * Keys that name an attachment payload outright. This list is a convenience,
 * not the guard — it can only ever enumerate names someone already thought of,
 * which is exactly how a PNG got through under the field's own name (`data`)
 * in #626. The magic-byte check is what does the real work.
 */
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

/** Base64 magic bytes for the formats the attachment feature accepts. */
const MAGIC_PREFIXES = [
  'iVBORw0KGgo', // PNG
  'JVBERi0', // PDF  (%PDF-)
  '/9j/', // JPEG
  'R0lGOD', // GIF
  'UklGR', // WEBP (RIFF)
];

const SPEC: GuardSpec = {
  suspectKeys: SUSPECT_KEYS,
  magicPrefixes: MAGIC_PREFIXES,
  keyReason: 'attachment-shaped key',
  failureHint:
    'received an argument carrying attachment data — chat routes must not persist image / PDF bytes',
};

/**
 * Assert that none of the recorded calls on `mock` carry attachment bytes.
 * Pass the mocked function, e.g. `prisma.aiMessage.create`.
 */
export function assertNoAttachmentPersistence(
  mock: { mock: { calls: unknown[][] } },
  label: string
): void {
  assertNoBinaryPersistence(mock, label, SPEC);
}
