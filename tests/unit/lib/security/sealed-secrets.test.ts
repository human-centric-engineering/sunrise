/**
 * Tests: sealing and opening secrets (§137 t-1043).
 *
 * Real Node crypto throughout; only the environment is replaced, because the
 * keyring is read from it. The ConQuest fixtures below were produced by
 * ConQuest's own `lib/app/leadgen/crypto/secret-box.ts` (at `4680433d1`),
 * with its `env` import swapped for the key below and nothing else changed.
 * They are what proves an app's existing values open without being resealed.
 *
 * @see lib/security/sealed-secrets.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface KeyringEnv {
  SEALED_SECRET_KEYS?: string;
  SEALED_SECRET_ACTIVE_KEY?: string;
  SEALED_SECRET_LEGACY_KEY?: string;
}
const mockEnv = vi.hoisted((): KeyringEnv => ({}));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

import {
  activeSealedSecretKeyId,
  isSealedSecretKeyConfigured,
  needsReseal,
  openSecret,
  sealSecret,
  SealedSecretKeyMissingError,
  SealedSecretOpenError,
  type SealedSecretOpenFailure,
} from '@/lib/security/sealed-secrets';

const KEY_2025 = 'older-master-key-0123456789abcdefghijklmn';
const KEY_2026 = 'newer-master-key-ZYXWVUTSRQPONMLKJIHGFEDC';
const CONQUEST_KEY = 'conquest-fixture-key-0123456789abcdefghij';

/** Sealed by ConQuest's helper under CONQUEST_KEY for 'crm:hubspot:access'. */
const CONQUEST_V1 = 'v1.RUPx0zJaLwAvvy-M.MAz8vErQe-Ng9Xgb3s97IQ.V30IQu61xOvAo3_1sfn6KQ7XzgE';
const CONQUEST_V1_EMPTY = 'v1.cZ77dQrNgKp_ReFc.vlhGt3lxXkuE_1zRQse6vg.';
const CONQUEST_PURPOSE = 'crm:hubspot:access';

const PURPOSE = 'org-provider-key:org_1:prov_1';
const PLAINTEXT = 'sk-live-0123456789-the-real-vendor-key';

function setKeyring(keys: Record<string, string>, active?: string, legacy?: string): void {
  mockEnv.SEALED_SECRET_KEYS = Object.entries(keys)
    .map(([id, secret]) => `${id}:${secret}`)
    .join(',');
  mockEnv.SEALED_SECRET_ACTIVE_KEY = active;
  mockEnv.SEALED_SECRET_LEGACY_KEY = legacy;
}

function clearKeyring(): void {
  delete mockEnv.SEALED_SECRET_KEYS;
  delete mockEnv.SEALED_SECRET_ACTIVE_KEY;
  delete mockEnv.SEALED_SECRET_LEGACY_KEY;
}

async function openFailure(sealed: string, purpose: string): Promise<SealedSecretOpenFailure> {
  try {
    await openSecret(sealed, purpose);
  } catch (err) {
    expect(err).toBeInstanceOf(SealedSecretOpenError);
    const error = err as SealedSecretOpenError;
    // No refusal carries any part of what it refused.
    for (const part of [sealed, PLAINTEXT, KEY_2025, KEY_2026, CONQUEST_KEY]) {
      if (part.length > 0) expect(error.message).not.toContain(part);
    }
    return error.reason;
  }
  throw new Error('expected the value to be refused');
}

/** Flip one character of the part at `index` (dot-separated) to another valid base64url one. */
function alterPart(sealed: string, index: number): string {
  const parts = sealed.split('.');
  const part = parts[index];
  const swapped = part[0] === 'A' ? 'B' : 'A';
  parts[index] = swapped + part.slice(1);
  return parts.join('.');
}

beforeEach(() => {
  clearKeyring();
  setKeyring({ k2026: KEY_2026 }, 'k2026');
});

describe('sealSecret / openSecret', () => {
  it('round-trips, under the active key, in the current format', async () => {
    const sealed = await sealSecret(PLAINTEXT, PURPOSE);
    expect(sealed.split('.').slice(0, 2)).toEqual(['v2', 'k2026']);
    expect(sealed).not.toContain(PLAINTEXT);
    await expect(openSecret(sealed, PURPOSE)).resolves.toBe(PLAINTEXT);
  });

  it('round-trips an empty string and non-ASCII text', async () => {
    await expect(openSecret(await sealSecret('', PURPOSE), PURPOSE)).resolves.toBe('');
    const text = 'clé-秘密-🔑';
    await expect(openSecret(await sealSecret(text, PURPOSE), PURPOSE)).resolves.toBe(text);
  });

  it('uses a fresh IV, so the same value never seals the same way twice', async () => {
    const a = await sealSecret(PLAINTEXT, PURPOSE);
    const b = await sealSecret(PLAINTEXT, PURPOSE);
    expect(a).not.toBe(b);
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
  });

  it('refuses the wrong purpose', async () => {
    const sealed = await sealSecret(PLAINTEXT, PURPOSE);
    expect(await openFailure(sealed, 'org-provider-key:org_2:prov_1')).toBe('mismatch');
  });

  it('refuses a value sealed under a different key with the same id', async () => {
    const sealed = await sealSecret(PLAINTEXT, PURPOSE);
    setKeyring({ k2026: KEY_2025 }, 'k2026');
    expect(await openFailure(sealed, PURPOSE)).toBe('mismatch');
  });

  it.each([
    ['the IV', 2],
    ['the tag', 3],
    ['the ciphertext', 4],
  ])('refuses a value with %s altered', async (_label, index) => {
    const sealed = await sealSecret(PLAINTEXT, PURPOSE);
    expect(await openFailure(alterPart(sealed, index), PURPOSE)).toBe('mismatch');
  });

  it('refuses a value whose key id was edited to another configured key', async () => {
    setKeyring({ k2026: KEY_2026, k2025: KEY_2025 }, 'k2026');
    const sealed = await sealSecret(PLAINTEXT, PURPOSE);
    const edited = sealed.replace(/^v2\.k2026\./, 'v2.k2025.');
    expect(await openFailure(edited, PURPOSE)).toBe('mismatch');
  });

  it('refuses a value whose key id was edited even when both ids hold the same key', async () => {
    // Only the authenticated key id can catch this: the key itself still fits.
    setKeyring({ k2026: KEY_2026, copy: KEY_2026 }, 'k2026');
    const sealed = await sealSecret(PLAINTEXT, PURPOSE);
    const edited = sealed.replace(/^v2\.k2026\./, 'v2.copy.');
    expect(await openFailure(edited, PURPOSE)).toBe('mismatch');
  });

  it('refuses a current value rewritten into the first format', async () => {
    setKeyring({ k2026: KEY_2026 }, 'k2026', 'k2026');
    const [, , iv, tag, body] = (await sealSecret(PLAINTEXT, PURPOSE)).split('.');
    expect(await openFailure(['v1', iv, tag, body].join('.'), PURPOSE)).toBe('mismatch');
  });

  it('refuses a value whose key is no longer configured, as unknown_key', async () => {
    const sealed = await sealSecret(PLAINTEXT, PURPOSE);
    setKeyring({ k2027: KEY_2025 }, 'k2027');
    expect(await openFailure(sealed, PURPOSE)).toBe('unknown_key');
  });

  it.each([
    ['plain text', 'not-a-sealed-secret'],
    ['an empty string', ''],
    ['too few parts', 'v2.k2026.AAAA.BBBB'],
    ['too many parts', 'v2.k2026.a.b.c.d'],
    ['an unknown version', 'v3.k2026.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA'],
    ['characters outside base64url', 'v2.k2026.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AA+/'],
    ['a short IV', 'v2.k2026.AAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA'],
    ['a short tag', 'v2.k2026.AAAAAAAAAAAAAAAA.AAAA.AAAA'],
  ])('refuses %s as format', async (_label, sealed) => {
    expect(await openFailure(sealed, PURPOSE)).toBe('format');
  });

  it('opens a value sealed under an older key after the active key moves', async () => {
    setKeyring({ k2025: KEY_2025 }, 'k2025');
    const old = await sealSecret(PLAINTEXT, PURPOSE);
    setKeyring({ k2026: KEY_2026, k2025: KEY_2025 }, 'k2026');
    await expect(openSecret(old, PURPOSE)).resolves.toBe(PLAINTEXT);
    expect((await sealSecret(PLAINTEXT, PURPOSE)).split('.')[1]).toBe('k2026');
  });

  it('refuses an empty purpose as a programming error', async () => {
    await expect(sealSecret(PLAINTEXT, '')).rejects.toBeInstanceOf(TypeError);
    await expect(openSecret('v2.x.y.z.w', '')).rejects.toBeInstanceOf(TypeError);
  });
});

describe('values ConQuest sealed before key ids existed', () => {
  beforeEach(() => {
    setKeyring({ k2026: KEY_2026, conquest: CONQUEST_KEY }, 'k2026', 'conquest');
  });

  it('open unchanged under the configured legacy key', async () => {
    await expect(openSecret(CONQUEST_V1, CONQUEST_PURPOSE)).resolves.toBe('sk-ant-fixture-token');
    await expect(openSecret(CONQUEST_V1_EMPTY, CONQUEST_PURPOSE)).resolves.toBe('');
  });

  it('still bind their purpose', async () => {
    expect(await openFailure(CONQUEST_V1, 'crm:hubspot:refresh')).toBe('mismatch');
  });

  it('refuse when the legacy key is a different key', async () => {
    setKeyring({ k2026: KEY_2026, conquest: KEY_2025 }, 'k2026', 'conquest');
    expect(await openFailure(CONQUEST_V1, CONQUEST_PURPOSE)).toBe('mismatch');
  });

  it('refuse as unknown_key when no legacy key is configured', async () => {
    setKeyring({ k2026: KEY_2026, conquest: CONQUEST_KEY }, 'k2026');
    expect(await openFailure(CONQUEST_V1, CONQUEST_PURPOSE)).toBe('unknown_key');
  });

  it('are never written: a new seal is in the current format', async () => {
    const sealed = await sealSecret('sk-ant-fixture-token', CONQUEST_PURPOSE);
    expect(sealed.startsWith('v2.k2026.')).toBe(true);
  });
});

describe('with no keyring configured', () => {
  beforeEach(() => clearKeyring());

  it('reports that it is not configured', () => {
    expect(isSealedSecretKeyConfigured()).toBe(false);
    expect(() => activeSealedSecretKeyId()).toThrow(SealedSecretKeyMissingError);
  });

  it('refuses to seal, rather than returning or storing plaintext', async () => {
    await expect(sealSecret(PLAINTEXT, PURPOSE)).rejects.toBeInstanceOf(
      SealedSecretKeyMissingError
    );
  });

  it('refuses to open', async () => {
    await expect(openSecret(CONQUEST_V1, CONQUEST_PURPOSE)).rejects.toBeInstanceOf(
      SealedSecretKeyMissingError
    );
  });

  it('refuses to say whether a value needs resealing', () => {
    expect(() => needsReseal(CONQUEST_V1)).toThrow(SealedSecretKeyMissingError);
  });

  it('treats a keyring the environment would have refused as none at all', async () => {
    // lib/env.ts refuses to boot on this; a mocked environment can still hold it.
    mockEnv.SEALED_SECRET_KEYS = `k2026:${KEY_2026}`;
    mockEnv.SEALED_SECRET_ACTIVE_KEY = 'missing';
    expect(isSealedSecretKeyConfigured()).toBe(false);
    await expect(sealSecret(PLAINTEXT, PURPOSE)).rejects.toBeInstanceOf(
      SealedSecretKeyMissingError
    );
  });
});

describe('needsReseal', () => {
  it('is false only for a current-format value under the active key', async () => {
    setKeyring({ k2025: KEY_2025 }, 'k2025', 'k2025');
    const old = await sealSecret(PLAINTEXT, PURPOSE);
    setKeyring({ k2026: KEY_2026, k2025: KEY_2025 }, 'k2026', 'k2025');
    const current = await sealSecret(PLAINTEXT, PURPOSE);

    expect(needsReseal(current)).toBe(false);
    expect(needsReseal(old)).toBe(true);
    expect(needsReseal(CONQUEST_V1)).toBe(true);
    expect(needsReseal('not-a-sealed-secret')).toBe(true);
  });

  it('names the active key', () => {
    expect(isSealedSecretKeyConfigured()).toBe(true);
    expect(activeSealedSecretKeyId()).toBe('k2026');
  });
});
