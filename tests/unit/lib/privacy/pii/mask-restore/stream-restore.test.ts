/**
 * Restoring a streamed reply. Every fixture is split at every character
 * position (and at every pair of positions for the shorter ones), and the
 * joined output must equal restoring the whole text at once.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TokenSession } from '@/lib/privacy/adapters/types';
import { restoreText } from '@/lib/privacy/pii/restore';
import { StreamRestorer } from '@/lib/privacy/pii/stream-restore';
import { statelessTokenStrategy } from '@/lib/privacy/pii/token-strategy';

function session(): TokenSession {
  const s = statelessTokenStrategy().createSession({ scopeId: 's' });
  s.placeholderFor('PERSON', 'James Hart'); // [PERSON_1]
  s.placeholderFor('PERSON', 'Priya Sharma'); // [PERSON_2]
  s.placeholderFor('EMAIL', 'j.hart@example.com'); // [EMAIL_1]
  s.placeholderFor('UK_NINO', 'TJ 33 15 36 A'); // [UK_NINO_1]
  s.placeholderFor('LITERAL', 'PERSON_1'); // [LITERAL_1]
  return s;
}

const FIXTURES = [
  'Dear [PERSON_1], thanks.',
  "[PERSON_1]'s order went to [PERSON_2] at [EMAIL_1].",
  'PERSON_1 and [PERSON_2 and PERSON_2] wrote', // lenient brackets
  'NI: [UK_NINO_1]. Not UK_NINO_2 or [PERSON_9].', // unresolved ones stay
  'xPERSON_1 MY_PERSON_1 PERSON_12 PERSON_01 [LITERAL_1]',
  '{"to": "[EMAIL_1]", "name": "[PERSON_1]"}',
  '😀 [PERSON_1] 😀[PERSON_2]',
  'Ends with a placeholder [PERSON_1]',
  'Ends with a bare one PERSON_2',
  'Ends with an open bracket [',
  'ALLCAPS WORDS LIKE OK AND HTTP_2 ARE NOT PLACEHOLDERS',
];

function streamed(text: string, cuts: number[]): { text: string; restorer: StreamRestorer } {
  const restorer = new StreamRestorer(session());
  let out = '';
  let at = 0;
  for (const cut of [...cuts, text.length]) {
    out += restorer.push(text.slice(at, cut));
    at = cut;
  }
  out += restorer.flush();
  return { text: out, restorer };
}

describe('StreamRestorer', () => {
  it.each(FIXTURES)('restores %j the same however it is split in two', (text) => {
    const whole = restoreText(text, session());
    for (let i = 0; i <= text.length; i++) {
      const { text: out, restorer } = streamed(text, [i]);
      expect(out, `split at ${i}`).toBe(whole.text);
      expect(restorer.restored, `split at ${i}`).toBe(whole.restored);
      expect([...restorer.unresolved], `split at ${i}`).toEqual(whole.unresolved);
    }
  });

  it.each(FIXTURES.filter((f) => f.length <= 60))(
    'restores %j split at every pair of points',
    (text) => {
      const whole = restoreText(text, session()).text;
      for (let i = 0; i <= text.length; i++) {
        for (let j = i; j <= text.length; j++) {
          expect(streamed(text, [i, j]).text, `split at ${i}, ${j}`).toBe(whole);
        }
      }
    }
  );

  it('restores a stream of one character at a time', () => {
    for (const text of FIXTURES) {
      const cuts = Array.from({ length: text.length }, (_, i) => i + 1);
      expect(streamed(text, cuts).text).toBe(restoreText(text, session()).text);
    }
  });

  it('leaves an unresolved placeholder visible and counts it, never guessing', () => {
    const { text, restorer } = streamed('Ask [PERSON_9] and [ORG_1]', [6, 12]);
    expect(text).toBe('Ask [PERSON_9] and [ORG_1]');
    expect(restorer.restored).toBe(0);
    expect([...restorer.unresolved]).toEqual(['[PERSON_9]', '[ORG_1]']);
  });

  it('holds back no more than 64 characters, even at the start of a stream', () => {
    const fresh = new StreamRestorer(session());
    expect(fresh.push('A'.repeat(65))).toBe('A'.repeat(65));
    const held = new StreamRestorer(session());
    expect(held.push('A'.repeat(64))).toBe('');
    expect(held.flush()).toBe('A'.repeat(64));
  });

  it('holds back only a possible placeholder, and no more than one', () => {
    const restorer = new StreamRestorer(session());
    expect(restorer.push('Dear [PER')).toBe('Dear ');
    expect(restorer.push('SON_1], all')).toBe('James Hart, all');
    // A long capitalised run cannot be a placeholder, so it is not held for ever.
    const long = 'A'.repeat(100);
    expect(restorer.push(` ${long}`)).toBe(` ${long}`);
    expect(restorer.flush()).toBe('');
  });

  it('looks at no more than the end of the text on each chunk', () => {
    // Deterministic, not timed: every hold-back check is a pattern ending in
    // `$`, and none may be handed more than MAX_HOLD + 1 characters however
    // long the stream has run.
    const exec = vi.spyOn(RegExp.prototype, 'exec');
    const restorer = new StreamRestorer(session());
    // Long chunks: with short ones the text checked is short anyway.
    const chunk = 'some ordinary words here, '.repeat(20) + 'AND CAPS';
    for (let i = 0; i < 50; i++) restorer.push(chunk);
    restorer.flush();
    const holdChecks = exec.mock.calls.filter((_, k) => {
      const re: unknown = exec.mock.contexts[k];
      return re instanceof RegExp && re.source.endsWith('$');
    });
    exec.mockRestore();
    expect(holdChecks.length).toBeGreaterThan(0);
    expect(Math.max(...holdChecks.map(([input]) => input.length))).toBeLessThanOrEqual(65);
  });

  it('releases a capitalised run that began in text already emitted', () => {
    // "xP" is emitted ("P" follows a letter); "ERSON_NAME" continues that
    // word, so nothing is held back waiting for it to become a placeholder.
    const restorer = new StreamRestorer(session());
    expect(restorer.push('xP')).toBe('xP');
    expect(restorer.push('ERSON_NAME')).toBe('ERSON_NAME');
  });
});
