/**
 * The provider credential seam (§120 t-744): its default, what a registered
 * resolver is given, and how it fails.
 *
 * @see lib/orchestration/llm/provider-credentials.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockMode = vi.hoisted(() => ({ value: 'single' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === 'TENANCY_MODE' ? mockMode.value : (Reflect.get(target, key) as unknown),
    }),
  };
});

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '@/lib/logging';
import {
  filterProvidersWithCredential,
  hasProviderCredential,
  hasProviderCredentialResolver,
  hasProviderKey,
  registerProviderCredentialResolver,
  resetProviderCredentialResolver,
  resolveProviderCredential,
  type ProviderCredentialConfig,
  type ProviderCredentialContext,
} from '@/lib/orchestration/llm/provider-credentials';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';

const ORG_A = 'cmorg00000000000000000orga';

function row(overrides: Partial<ProviderCredentialConfig> = {}): ProviderCredentialConfig {
  return {
    id: 'p1',
    slug: 'anthropic',
    name: 'Anthropic',
    providerType: 'anthropic',
    apiKeyEnvVar: 'CRED_TEST_KEY',
    isLocal: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderCredentialResolver();
  mockMode.value = 'single';
  process.env.CRED_TEST_KEY = 'from-env';
  delete process.env.CRED_TEST_UNSET;
});

afterEach(() => {
  resetProviderCredentialResolver();
  delete process.env.CRED_TEST_KEY;
});

describe('with nothing registered', () => {
  it("reads the row's env var, on the shared identity", async () => {
    expect(hasProviderCredentialResolver()).toBe(false);
    await expect(resolveProviderCredential(row())).resolves.toEqual({
      apiKey: 'from-env',
      identity: '',
    });
  });

  it('answers no key for an unset or absent env var', async () => {
    await expect(
      resolveProviderCredential(row({ apiKeyEnvVar: 'CRED_TEST_UNSET' }))
    ).resolves.toEqual({ apiKey: undefined, identity: '' });
    await expect(resolveProviderCredential(row({ apiKeyEnvVar: null }))).resolves.toEqual({
      apiKey: undefined,
      identity: '',
    });
  });

  it('calls a row reachable exactly as before: local, or its env var set', async () => {
    await expect(hasProviderCredential(row())).resolves.toBe(true);
    await expect(hasProviderCredential(row({ apiKeyEnvVar: 'CRED_TEST_UNSET' }))).resolves.toBe(
      false
    );
    await expect(hasProviderCredential(row({ apiKeyEnvVar: null, isLocal: true }))).resolves.toBe(
      true
    );
  });

  it('reports a key, not reachability, for the admin flag: a local row without one has none', async () => {
    await expect(hasProviderKey(row())).resolves.toBe(true);
    await expect(
      hasProviderKey(row({ isLocal: true, apiKeyEnvVar: 'CRED_TEST_UNSET' }))
    ).resolves.toBe(false);
  });

  it('checks reachability silently: the missing-key warning belongs to building a client', async () => {
    await hasProviderCredential(row({ apiKeyEnvVar: 'CRED_TEST_UNSET' }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the order of the rows it keeps', async () => {
    const rows = [
      row({ slug: 'a' }),
      row({ slug: 'b', apiKeyEnvVar: 'CRED_TEST_UNSET' }),
      row({ slug: 'c', isLocal: true, apiKeyEnvVar: null }),
    ];
    const kept = await filterProvidersWithCredential(rows);
    expect(kept.map((r) => r.slug)).toEqual(['a', 'c']);
  });
});

describe('a registered resolver', () => {
  it('is given the row and the org in context, and its answer is used', async () => {
    const seen: ProviderCredentialContext[] = [];
    registerProviderCredentialResolver((config, ctx) => {
      seen.push(ctx);
      return { apiKey: `key-${ctx.orgId}-${config.slug}`, identity: `org:${ctx.orgId}` };
    });

    const credential = await runAsOrg(ORG_A, () => resolveProviderCredential(row()));

    expect(credential).toEqual({ apiKey: `key-${ORG_A}-anthropic`, identity: `org:${ORG_A}` });
    expect(seen).toEqual([{ orgId: ORG_A }]);
  });

  it('is told the install org at single when no scope was entered, and no org at multi', async () => {
    const seen: ProviderCredentialContext[] = [];
    registerProviderCredentialResolver((_config, ctx) => {
      seen.push(ctx);
      return { apiKey: 'k', identity: '' };
    });

    await resolveProviderCredential(row());
    mockMode.value = 'multi';
    await resolveProviderCredential(row());
    await runAsSystem('credential test', () => resolveProviderCredential(row()));

    expect(seen).toEqual([{ orgId: INSTALL_ORG_ID }, { orgId: null }, { orgId: null }]);
  });

  it('does not fall back to the env var when it throws — the provider is unavailable', async () => {
    registerProviderCredentialResolver(() => {
      throw new Error('vault sealed');
    });

    await expect(resolveProviderCredential(row())).rejects.toMatchObject({
      code: 'credential_unavailable',
      retriable: false,
    });
    await expect(hasProviderCredential(row())).resolves.toBe(false);
  });

  it('refuses an answer that is not a credential, without logging what it was', async () => {
    registerProviderCredentialResolver(() => ({ apiKey: 'sk-secret-value', identity: 'org#a' }));

    await expect(resolveProviderCredential(row())).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).toContain('identity');
    expect(logged).not.toContain('sk-secret-value');
  });

  it('treats an empty key as no key', async () => {
    registerProviderCredentialResolver(() => ({ apiKey: '', identity: 'x' }));
    await expect(resolveProviderCredential(row())).resolves.toEqual({
      apiKey: undefined,
      identity: 'x',
    });
    await expect(hasProviderCredential(row())).resolves.toBe(false);
  });

  it('asks the resolver about a local row too: one it cannot answer for is not reachable', async () => {
    // getProvider asks the resolver for every row, local or not, so a row the
    // resolver throws for can never be built — reachability must agree.
    registerProviderCredentialResolver((config) => {
      if (config.slug === 'ollama') throw new Error('unknown slug');
      return { apiKey: undefined, identity: '' };
    });

    await expect(
      hasProviderCredential(row({ slug: 'ollama', isLocal: true, apiKeyEnvVar: null }))
    ).resolves.toBe(false);
    // A local row the resolver answers needs no key.
    await expect(
      hasProviderCredential(row({ slug: 'lmstudio', isLocal: true, apiKeyEnvVar: null }))
    ).resolves.toBe(true);
  });

  it('is one rule: the same function again is a no-op, a different one throws', () => {
    const rule = () => ({ apiKey: 'k', identity: '' });
    registerProviderCredentialResolver(rule);
    expect(() => registerProviderCredentialResolver(rule)).not.toThrow();
    expect(() => registerProviderCredentialResolver(() => rule())).toThrow(
      /different resolver is already registered/
    );
  });
});
