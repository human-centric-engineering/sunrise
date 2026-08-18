/**
 * Unit Tests: Audio-Persistence Guard
 *
 * Sibling of `no-attachment-persistence.test.ts`, and here for the same reason:
 * `tests/` is excluded from coverage (`vitest.config.ts`), so the guard that two
 * real tests depend on had no test of its own.
 *
 * This guard shared the attachment guard's blind spot — it matched a fixed list
 * of suspect KEY names, so audio bytes under any other key passed straight
 * through. Hardened alongside it in #626 with a value-shape check. The
 * magic-byte cases below are the ones that would have caught the gap.
 *
 * Verified against the pre-hardening helper (`d67b1d7b`): the value-shape cases
 * FAIL there, so they are genuine regression tests. The key-name and binary
 * cases pass against it — coverage of behaviour that already worked, kept so a
 * future edit to `walk()` cannot quietly drop it.
 *
 * @see tests/helpers/no-audio-persistence.ts
 * @see tests/unit/helpers/no-attachment-persistence.test.ts
 */

import { describe, it, expect, vi } from 'vitest';
import { assertNoAudioPersistence } from '@/tests/helpers/no-audio-persistence';

/** A minimal RIFF/WAVE header — what a real recording starts with. */
const WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';

/** ID3-tagged MP3. */
const MP3_BASE64 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00fake').toString('base64');

function mockWithCall(arg: unknown) {
  const m = vi.fn();
  m(arg);
  return m as unknown as { mock: { calls: unknown[][] } };
}

describe('assertNoAudioPersistence', () => {
  describe('binary values', () => {
    it('rejects a Buffer anywhere in the tree', () => {
      const mock = mockWithCall({ data: { metadata: { clip: Buffer.from('bytes') } } });

      expect(() => assertNoAudioPersistence(mock, 'probe')).toThrow(/binary value/);
    });
  });

  describe('suspect key names', () => {
    it('rejects a known audio key', () => {
      const mock = mockWithCall({ data: { audioData: 'x' } });

      expect(() => assertNoAudioPersistence(mock, 'probe')).toThrow(/audio-shaped key "audioData"/);
    });
  });

  describe('base64 payloads, whatever the key is called', () => {
    // The regression the key list could not catch.
    it('rejects a WAV under a benign key', () => {
      const mock = mockWithCall({
        data: { metadata: { blobs: [{ n: 'note.wav', payload: WAV_BASE64 }] } },
      });

      expect(() => assertNoAudioPersistence(mock, 'probe')).toThrow(/UklGR/);
    });

    it('rejects an MP3 under a benign key', () => {
      const mock = mockWithCall({ data: { metadata: { clip: MP3_BASE64 } } });

      expect(() => assertNoAudioPersistence(mock, 'probe')).toThrow(/SUQz/);
    });

    it('rejects a data: URI, the form a MediaRecorder blob reads back as', () => {
      const mock = mockWithCall({
        data: { metadata: { src: `data:audio/wav;base64,${WAV_BASE64}` } },
      });

      expect(() => assertNoAudioPersistence(mock, 'probe')).toThrow(/UklGR/);
    });

    it('names the path so the failure is diagnosable', () => {
      const mock = mockWithCall({ data: { metadata: { blobs: [{ payload: WAV_BASE64 }] } } });

      expect(() => assertNoAudioPersistence(mock, 'probe')).toThrow(
        /arg0\.data\.metadata\.blobs\[0\]\.payload/
      );
    });
  });

  describe('does not fire on what the transcription flow legitimately persists', () => {
    it('accepts a transcript row: text, ids and duration, no bytes', () => {
      const mock = mockWithCall({
        data: {
          conversationId: 'cmjbv4i3x00003wsloputgwul',
          role: 'user',
          content: 'Transcribed: can you summarise the meeting notes please',
          metadata: { app: { durationMs: 4200, source: 'speech-to-text' } },
        },
      });

      expect(() => assertNoAudioPersistence(mock, 'probe')).not.toThrow();
    });

    it('accepts base64-alphabet ids below the length floor', () => {
      const mock = mockWithCall({ data: { id: 'cmjbv4i3x00003wsloputgwul', model: 'whisper1' } });

      expect(() => assertNoAudioPersistence(mock, 'probe')).not.toThrow();
    });

    it('accepts a long PROSE transcript, punctuated or not', () => {
      // Transcripts are unbounded in length; flagging them would break the two
      // real consumers of this guard. The unpunctuated variant is the one the
      // removed length+alphabet rule actually failed on (#626 review round 2).
      const punctuated = mockWithCall({ data: { content: 'so then he said. '.repeat(60) } });
      const bare = mockWithCall({ data: { content: 'so then he said '.repeat(60) } });

      expect(() => assertNoAudioPersistence(punctuated, 'probe')).not.toThrow();
      expect(() => assertNoAudioPersistence(bare, 'probe')).not.toThrow();
    });
  });

  describe('traversal safety', () => {
    it('terminates on a cyclic argument rather than hanging', () => {
      const cyclic: Record<string, unknown> = { name: 'loop' };
      cyclic.self = cyclic;

      expect(() => assertNoAudioPersistence(mockWithCall(cyclic), 'probe')).not.toThrow();
    });
  });
});
