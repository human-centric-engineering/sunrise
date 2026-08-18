/**
 * Test helper: assert audio bytes never reach the database.
 *
 * Used by the transcribe-route regression tests to lock in the audit invariant
 * that the request handlers MUST NOT persist audio — only the transcript text
 * is stored, and only an aggregate cost row goes to `AiCostLog`.
 *
 * The detection logic, the reasoning behind it, and the deliberate limits of
 * what it can catch all live in `no-binary-persistence.ts`. Read that before
 * changing anything here.
 *
 * @see tests/helpers/no-binary-persistence.ts
 * @see tests/helpers/no-attachment-persistence.ts
 */

import { assertNoBinaryPersistence, type GuardSpec } from '@/tests/helpers/no-binary-persistence';

/**
 * Keys that name an audio payload outright. A convenience, not the guard — it
 * enumerates only the names someone already thought of. Note it does NOT
 * include bare `bytes` or `data`; an earlier version of this file's docblock
 * claimed it did, which is the same false guarantee that let a PNG through the
 * attachment guard (#626). The magic-byte check is what does the real work.
 */
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

/** Base64 magic bytes for the audio containers the transcribe route accepts. */
const MAGIC_PREFIXES = [
  'UklGR', // RIFF / WAV
  'SUQz', // ID3  / MP3
  'T2dnUw', // OggS / OGG, Opus
  'GkXf', // EBML / WebM, Matroska
  '//uQ', // MPEG frame sync / bare MP3
];

const SPEC: GuardSpec = {
  suspectKeys: SUSPECT_KEYS,
  magicPrefixes: MAGIC_PREFIXES,
  keyReason: 'audio-shaped key',
  failureHint:
    'received an argument carrying audio data — the transcribe route must not persist audio bytes',
};

/**
 * Assert that none of the recorded calls on `mock` carry audio bytes.
 * Pass the mocked function, e.g. `vi.mocked(logCost)`.
 */
export function assertNoAudioPersistence(
  mock: { mock: { calls: unknown[][] } },
  label: string
): void {
  assertNoBinaryPersistence(mock, label, SPEC);
}
