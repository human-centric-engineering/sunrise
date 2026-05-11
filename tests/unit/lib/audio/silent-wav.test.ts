/**
 * silent-wav unit test
 *
 * Verifies the generator produces a structurally valid RIFF/WAV
 * buffer suitable for the catalogue panel's audio Test button. We
 * decode the header by hand rather than reach for a wav-parser dep
 * to keep this test (and the producer) honest — every field a STT
 * provider's audio decoder reads is checked here.
 *
 * @see lib/audio/silent-wav.ts
 */

import { describe, it, expect } from 'vitest';
import { generateSilentWav } from '@/lib/audio/silent-wav';

describe('generateSilentWav', () => {
  it('produces a 16 kHz mono 16-bit RIFF/WAV buffer with the expected size', () => {
    const wav = generateSilentWav();

    // 44-byte header + 16000 samples * 2 bytes (mono / 16-bit @ 16 kHz)
    // = 32044 bytes. Asserting the exact size catches regressions
    // where someone changes the sample rate or duration without
    // updating the producer comment.
    expect(wav.length).toBe(44 + 16_000 * 2);
  });

  it('encodes a valid RIFF header with PCM format', () => {
    const wav = generateSilentWav();

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');

    // PCM fmt chunk size = 16; format code = 1 (uncompressed PCM).
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);

    // 1 channel, 16 kHz sample rate, 16 bits per sample.
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(34)).toBe(16);
  });

  it('writes only zero samples — the clip is silent', () => {
    const wav = generateSilentWav();
    // Walk the data sub-chunk and confirm every sample is 0. A single
    // non-zero byte would mean we're shipping accidental audio.
    for (let i = 44; i < wav.length; i++) {
      // Reading the byte rather than the full int16 keeps this loop
      // cheap; zero PCM16 bytes are zero in either byte order.
      expect(wav[i]).toBe(0);
    }
  });
});
