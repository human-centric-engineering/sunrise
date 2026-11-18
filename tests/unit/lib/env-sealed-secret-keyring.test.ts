// @vitest-environment node
/**
 * Tests: `lib/env.ts` refuses to boot on a broken sealed-secret keyring, and
 * says why without printing a secret (§137 t-1043).
 *
 * The keyring's three variables are checked together by a refinement on the
 * parse, so these load the real module fresh per case, as `env.test.ts` does.
 * The reader's own rules are tested in
 * `tests/unit/lib/security/sealed-secret-keys.test.ts`; this file proves the
 * boot actually runs them.
 *
 * @see lib/env.ts — checkSealedSecretKeyring
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'boot-test-master-key-0123456789abcdefghijkl';

const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/mydb',
  BETTER_AUTH_URL: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NODE_ENV: 'test',
};

const MANAGED = [
  ...Object.keys(BASE),
  'SEALED_SECRET_KEYS',
  'SEALED_SECRET_ACTIVE_KEY',
  'SEALED_SECRET_LEGACY_KEY',
];

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
});

afterEach(() => {
  for (const key of MANAGED) delete process.env[key];
  Object.assign(process.env, saved);
  vi.restoreAllMocks();
  vi.resetModules();
});

async function boot(vars: Record<string, string>) {
  for (const key of MANAGED) delete process.env[key];
  Object.assign(process.env, BASE, vars);
  vi.resetModules();
  return (await import('@/lib/env')).env;
}

describe('the sealed-secret keyring at boot', () => {
  it('boots with no keyring, the shipped state', async () => {
    const env = await boot({});
    expect(env.SEALED_SECRET_KEYS).toBeUndefined();
  });

  it('boots with a valid keyring and exposes it', async () => {
    const env = await boot({
      SEALED_SECRET_KEYS: `k2026:${SECRET}`,
      SEALED_SECRET_ACTIVE_KEY: 'k2026',
    });
    expect(env.SEALED_SECRET_ACTIVE_KEY).toBe('k2026');
  });

  it('refuses an active key that is not in the keyring, naming the variable and no secret', async () => {
    const printed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });

    await expect(
      boot({ SEALED_SECRET_KEYS: `k2026:${SECRET}`, SEALED_SECRET_ACTIVE_KEY: 'k2027' })
    ).rejects.toThrow(/Environment validation failed/);

    const output = printed.join('\n');
    expect(output).toContain('SEALED_SECRET_ACTIVE_KEY');
    // Printed as JSON, so the id's quotes are escaped.
    expect(output).toContain('k2027');
    expect(output).not.toContain(SECRET);
  });

  it('reports a broken keyring on the same boot as another broken variable', async () => {
    const printed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });

    await expect(
      boot({
        DATABASE_URL: 'not-a-url',
        SEALED_SECRET_KEYS: `k2026:${SECRET}`,
        SEALED_SECRET_ACTIVE_KEY: 'k2027',
      })
    ).rejects.toThrow(/Environment validation failed/);

    const output = printed.join('\n');
    expect(output).toContain('DATABASE_URL');
    expect(output).toContain('SEALED_SECRET_ACTIVE_KEY');
    expect(output).not.toContain(SECRET);
  });

  it('refuses the .env.example placeholder as it stands', async () => {
    await expect(
      boot({ SEALED_SECRET_KEYS: 'k2026:<replace-me>', SEALED_SECRET_ACTIVE_KEY: 'k2026' })
    ).rejects.toThrow(/Environment validation failed/);
  });

  it('refuses a malformed key entry without printing it', async () => {
    const printed: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });

    await expect(
      boot({ SEALED_SECRET_KEYS: SECRET, SEALED_SECRET_ACTIVE_KEY: 'k2026' })
    ).rejects.toThrow(/Environment validation failed/);

    const output = printed.join('\n');
    expect(output).toContain('SEALED_SECRET_KEYS');
    expect(output).not.toContain(SECRET);
  });
});
