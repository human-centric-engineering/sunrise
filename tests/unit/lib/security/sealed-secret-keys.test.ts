/**
 * Tests: reading the sealed-secret keyring from its variables.
 *
 * The reader runs at boot (`lib/env.ts`) and its problems are printed there,
 * so beside "is the keyring read right" every refusal is checked for the one
 * thing it must never do: print a secret.
 *
 * @see lib/security/sealed-secret-keys.ts
 */

import { describe, expect, it } from 'vitest';

import {
  readSealedSecretKeyring,
  type SealedSecretKeyringRead,
} from '@/lib/security/sealed-secret-keys';

const SECRET_A = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0uv=';
const SECRET_B = 'zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLK==';

function problemsOf(read: SealedSecretKeyringRead) {
  if (read.ok) throw new Error('expected the keyring to be refused');
  return read.problems;
}

/** No problem message may contain any secret it was handed. */
function expectNoSecretIn(read: SealedSecretKeyringRead, ...secrets: string[]) {
  const text = JSON.stringify(problemsOf(read));
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe('readSealedSecretKeyring', () => {
  it('answers no keyring when none of the variables is set', () => {
    expect(readSealedSecretKeyring({})).toEqual({ ok: true, keyring: null });
  });

  it('reads every key, the active id and the legacy id', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `k2026:${SECRET_A}, k2025:${SECRET_B}`,
      SEALED_SECRET_ACTIVE_KEY: 'k2026',
      SEALED_SECRET_LEGACY_KEY: 'k2025',
    });
    expect(read.ok).toBe(true);
    if (!read.ok || !read.keyring) throw new Error('unreachable');
    expect([...read.keyring.keys.entries()]).toEqual([
      ['k2026', SECRET_A],
      ['k2025', SECRET_B],
    ]);
    expect(read.keyring.activeKeyId).toBe('k2026');
    expect(read.keyring.legacyKeyId).toBe('k2025');
  });

  it('keeps a colon inside a secret, splitting only at the first', () => {
    const secret = `${SECRET_A}:tail`;
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one:${secret}`,
      SEALED_SECRET_ACTIVE_KEY: 'one',
    });
    if (!read.ok || !read.keyring) throw new Error('expected a keyring');
    expect(read.keyring.keys.get('one')).toBe(secret);
    expect(read.keyring.legacyKeyId).toBeUndefined();
  });

  it('requires an explicit active key, even with only one key', () => {
    const read = readSealedSecretKeyring({ SEALED_SECRET_KEYS: `one:${SECRET_A}` });
    expect(problemsOf(read).map((p) => p.variable)).toEqual(['SEALED_SECRET_ACTIVE_KEY']);
    expectNoSecretIn(read, SECRET_A);
  });

  it('refuses an active or legacy id that is not a configured key', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one:${SECRET_A}`,
      SEALED_SECRET_ACTIVE_KEY: 'two',
      SEALED_SECRET_LEGACY_KEY: 'three',
    });
    expect(problemsOf(read).map((p) => p.variable)).toEqual([
      'SEALED_SECRET_ACTIVE_KEY',
      'SEALED_SECRET_LEGACY_KEY',
    ]);
    expect(problemsOf(read)[0].message).toContain('"two"');
  });

  it('does not echo a secret pasted into the active-key variable', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one:${SECRET_A}`,
      SEALED_SECRET_ACTIVE_KEY: SECRET_B,
    });
    expect(problemsOf(read)[0].variable).toBe('SEALED_SECRET_ACTIVE_KEY');
    expectNoSecretIn(read, SECRET_A, SECRET_B);
  });

  it('refuses the active or legacy id set without any keys, once', () => {
    const read = readSealedSecretKeyring({ SEALED_SECRET_ACTIVE_KEY: 'one' });
    expect(problemsOf(read).map((p) => p.variable)).toEqual(['SEALED_SECRET_KEYS']);
    const legacyOnly = readSealedSecretKeyring({ SEALED_SECRET_LEGACY_KEY: 'one' });
    expect(problemsOf(legacyOnly).map((p) => p.variable)).toEqual(['SEALED_SECRET_KEYS']);
  });

  it('skips the empty entry a trailing comma leaves', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one:${SECRET_A},`,
      SEALED_SECRET_ACTIVE_KEY: 'one',
    });
    if (!read.ok || !read.keyring) throw new Error('expected a keyring');
    expect([...read.keyring.keys.keys()]).toEqual(['one']);
  });

  it('refuses spaces around a secret rather than making them key material', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one: ${SECRET_A}`,
      SEALED_SECRET_ACTIVE_KEY: 'one',
    });
    expect(problemsOf(read)).toEqual([
      expect.objectContaining({
        variable: 'SEALED_SECRET_KEYS',
        message: expect.stringMatching(/spaces around its secret/),
      }),
    ]);
    expectNoSecretIn(read, SECRET_A);
  });

  it('refuses an empty value rather than reading it as unset', () => {
    const read = readSealedSecretKeyring({ SEALED_SECRET_KEYS: '', SEALED_SECRET_ACTIVE_KEY: '' });
    expect(problemsOf(read).map((p) => p.variable)).toEqual([
      'SEALED_SECRET_KEYS',
      'SEALED_SECRET_ACTIVE_KEY',
    ]);
  });

  it.each([
    ['an entry with no separator', `${SECRET_A}`, /not an id:secret pair/],
    ['an id with capitals', `K2026:${SECRET_A}`, /invalid id/],
    ['an id with a dot', `k.1:${SECRET_A}`, /invalid id/],
    ['an id longer than 32 characters', `${'a'.repeat(33)}:${SECRET_A}`, /invalid id/],
    ['a short secret', `one:${'x'.repeat(31)}`, /shorter than 32/],
  ])('refuses %s, without printing it', (_label, keys, message) => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: keys,
      SEALED_SECRET_ACTIVE_KEY: 'one',
    });
    const problems = problemsOf(read);
    expect(problems[0]).toMatchObject({ variable: 'SEALED_SECRET_KEYS' });
    expect(problems[0].message).toMatch(message);
    expectNoSecretIn(read, SECRET_A, 'x'.repeat(31));
  });

  it('reports a short active key once, not also as missing from the keyring', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one:${'x'.repeat(31)}`,
      SEALED_SECRET_ACTIVE_KEY: 'one',
      SEALED_SECRET_LEGACY_KEY: 'one',
    });
    expect(problemsOf(read)).toEqual([
      expect.objectContaining({
        variable: 'SEALED_SECRET_KEYS',
        message: expect.stringMatching(/shorter than 32/),
      }),
    ]);
  });

  it('refuses a key id named twice', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one:${SECRET_A},one:${SECRET_B}`,
      SEALED_SECRET_ACTIVE_KEY: 'one',
    });
    expect(problemsOf(read)[0].message).toMatch(/twice/);
    expectNoSecretIn(read, SECRET_A, SECRET_B);
  });

  it('accepts a 32-character secret, the shortest allowed', () => {
    const read = readSealedSecretKeyring({
      SEALED_SECRET_KEYS: `one:${'x'.repeat(32)}`,
      SEALED_SECRET_ACTIVE_KEY: 'one',
    });
    expect(read.ok).toBe(true);
  });
});
