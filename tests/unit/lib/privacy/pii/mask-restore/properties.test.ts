/**
 * Properties of masking and restoring, over generated inputs (§127, t-990).
 *
 * The generator is seeded, so a failure names a seed that reproduces it.
 * Inputs mix ordinary words, values, emoji and — on purpose — text that
 * already looks like a placeholder, the case that would break the round trip
 * if masking did not escape it.
 */
import { describe, expect, it } from 'vitest';
import { CORE_ENTITY_TYPES } from '@/lib/privacy/adapters/types';
import { maskText, type MaskSpan } from '@/lib/privacy/pii/mask';
import { restoreText } from '@/lib/privacy/pii/restore';
import { statelessTokenStrategy } from '@/lib/privacy/pii/token-strategy';

/** mulberry32: small, fast, and the same everywhere. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAGMENTS = [
  'hello',
  'the',
  'order',
  'James Hart',
  'Halden Ltd',
  'a@example.com',
  '020 7946 0958',
  '😀',
  'é',
  ' ',
  ' ',
  ', ',
  '. ',
  '\n',
  '"',
  "'s",
  '[',
  ']',
  '_',
  '1',
  // Look-alikes: restoring must give these back exactly as written.
  'PERSON_1',
  '[PERSON_2]',
  '[ORG_1',
  'EMAIL_3]',
  '[LITERAL_1]',
  'MY_PERSON_1',
  'PERSON_01',
];

function generate(next: () => number): { text: string; spans: MaskSpan[] } {
  const parts: string[] = [];
  const n = 1 + Math.floor(next() * 30);
  for (let i = 0; i < n; i++) parts.push(FRAGMENTS[Math.floor(next() * FRAGMENTS.length)]);
  const text = parts.join('');
  // Random, possibly overlapping, spans of random core types.
  const spans: MaskSpan[] = [];
  const count = Math.floor(next() * 6);
  for (let i = 0; i < count && text.length > 0; i++) {
    const start = Math.floor(next() * text.length);
    const end = Math.min(text.length, start + 1 + Math.floor(next() * 15));
    spans.push({
      type: CORE_ENTITY_TYPES[Math.floor(next() * CORE_ENTITY_TYPES.length)],
      start,
      end,
    });
  }
  return { text, spans };
}

describe('restore(mask(x)) = x', () => {
  it('holds for 2,000 generated inputs', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const { text, spans } = generate(rng(seed));
      const session = statelessTokenStrategy().createSession({ scopeId: 's' });
      const masked = maskText(text, spans, session, []);
      const restored = restoreText(masked.text, session);
      expect(restored.text, `seed ${seed}`).toBe(text);
      expect(restored.unresolved, `seed ${seed}`).toEqual([]);
    }
  });

  it('leaves nothing a span covered in the masked text', () => {
    // Values that occur only inside spans: if any of one survives masking,
    // it went out. (Checking for placeholders would pass whatever happened,
    // because masking inserted them.)
    for (let seed = 1; seed <= 2000; seed++) {
      const next = rng(seed);
      const { text: filler } = generate(next);
      // Build the whole text first, then the spans: a span may reach past
      // its secret on either side, into the text around it.
      const pieces: string[] = [];
      const secretAt: { start: number; end: number }[] = [];
      let text = '';
      for (let i = 0; i < 4; i++) {
        const cut = Math.floor(next() * (filler.length + 1));
        text += filler.slice(0, cut);
        const secret = `QZX${seed}V${i}QZX`;
        secretAt.push({ start: text.length, end: text.length + secret.length });
        text += secret + filler.slice(cut);
        pieces.push(secret);
      }
      const spans: MaskSpan[] = secretAt.map(({ start, end }) => ({
        type: 'PERSON',
        start: Math.max(0, start - Math.floor(next() * 3)),
        end: Math.min(text.length, end + Math.floor(next() * 3)),
      }));
      const session = statelessTokenStrategy().createSession({ scopeId: 's' });
      const masked = maskText(text, spans, session, []).text;
      expect(masked, `seed ${seed}`).not.toMatch(/QZX/);
      expect(restoreText(masked, session).text, `seed ${seed}`).toBe(text);
    }
  });
});

describe('masking a growing history', () => {
  it('masks the earlier messages the same way on every call', () => {
    // Each call masks the whole history so far, in order, with a fresh
    // session; what it sends for the first k messages must not change as the
    // history grows, or provider prompt caching breaks.
    for (let seed = 1; seed <= 200; seed++) {
      const next = rng(seed);
      const history = Array.from({ length: 6 }, () => generate(next));
      let previous: string[] = [];
      for (let k = 1; k <= history.length; k++) {
        const session = statelessTokenStrategy().createSession({ scopeId: 's' });
        const sent = history.slice(0, k).map((m) => maskText(m.text, m.spans, session, []).text);
        expect(sent.slice(0, previous.length), `seed ${seed}, call ${k}`).toEqual(previous);
        previous = sent;
      }
    }
  });
});
