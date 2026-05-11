/**
 * Tiny in-memory silent WAV generator.
 *
 * Used by the catalogue panel's Test button (audio capability) — posts
 * a 1-second silent clip to a provider's transcription endpoint so the
 * operator can verify the API key, base URL, and model id are
 * reachable. Real audio is unnecessary for a connectivity check, and
 * silence avoids licensing concerns + storage overhead.
 *
 * Format: 16 kHz mono PCM16, 1 second. Whisper-class endpoints accept
 * WAV at this rate and won't reject the empty signal; most will return
 * an empty `text` field (some return a single space), which is fine —
 * the Test button only cares about the round-trip succeeding.
 *
 * Total size = 44-byte RIFF header + (16000 samples * 2 bytes) ≈ 32 kB.
 * Small enough to keep in memory and ship as part of the POST body.
 */

const SAMPLE_RATE = 16_000;
const BITS_PER_SAMPLE = 16;
const NUM_CHANNELS = 1;
const DURATION_SECONDS = 1;

/**
 * Generate a `Buffer` containing a valid RIFF/WAV-encoded silent clip.
 *
 * The header layout follows the canonical RIFF spec — see
 * https://docs.fileformat.com/audio/wav/. We hand-build it rather
 * than pull in a wav-encoder dep because every field is fixed for
 * our use case (1 second, 16 kHz, mono, PCM16) and the resulting
 * bytes are byte-for-byte identical across invocations.
 */
export function generateSilentWav(): Buffer {
  const numSamples = SAMPLE_RATE * DURATION_SECONDS;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const blockAlign = NUM_CHANNELS * bytesPerSample;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = numSamples * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const buf = Buffer.alloc(totalSize);

  // RIFF header — "RIFF" + chunk size + "WAVE".
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(totalSize - 8, 4);
  buf.write('WAVE', 8, 'ascii');

  // fmt sub-chunk — describes the audio format.
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM format (1 = uncompressed)
  buf.writeUInt16LE(NUM_CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(BITS_PER_SAMPLE, 34);

  // data sub-chunk — the PCM samples themselves. `Buffer.alloc` zero-
  // fills, so the data region is already silent; we only need to
  // write the header markers.
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  return buf;
}
