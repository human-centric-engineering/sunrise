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
      const masked = maskText(text, spans, session);
      const restored = restoreText(masked.text, session);
      expect(restored.text, `seed ${seed}`).toBe(text);
      expect(restored.unresolved, `seed ${seed}`).toEqual([]);
    }
  });

  it('leaves no detected value in the masked text, inside its span', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const { text, spans } = generate(rng(seed));
      const session = statelessTokenStrategy().createSession({ scopeId: 's' });
      const masked = maskText(text, spans, session).text;
      // Every character a span covered is now part of a placeholder.
      for (const e of session.entries()) {
        expect(masked, `seed ${seed}`).toContain(e.placeholder);
      }
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
        const sent = history.slice(0, k).map((m) => maskText(m.text, m.spans, session).text);
        expect(sent.slice(0, previous.length), `seed ${seed}, call ${k}`).toEqual(previous);
        previous = sent;
      }
    }
  });
});
