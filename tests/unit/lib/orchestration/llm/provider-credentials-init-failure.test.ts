/**
 * The provider credential seam when the fork's init throws (§120 t-744).
 *
 * The shared gate rolls the registration back and logs it; this seam then
 * REFUSES every credential rather than serving the env var, because a fork that
 * moved its keys out of the environment did not mean the environment's key to
 * be used for its orgs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The fork's init registers a resolver, then throws: the partial registration
// is what the rollback has to undo. The registrar is handed in after import,
// because the mock factory runs before the module under test exists.
const hoisted = vi.hoisted(() => ({
  register: null as null | ((fn: () => { apiKey: string; identity: string }) => void),
}));
vi.mock('@/lib/app/provider-credentials', () => ({
  initAppProviderCredentials: () => {
    hoisted.register?.(() => ({ apiKey: 'from-fork', identity: 'fork' }));
    throw new Error('vault client misconfigured');
  },
}));

import { logger } from '@/lib/logging';
import {
  hasProviderCredential,
  hasProviderCredentialResolver,
  registerProviderCredentialResolver,
  resetProviderCredentialResolver,
  resolveProviderCredential,
} from '@/lib/orchestration/llm/provider-credentials';

hoisted.register = registerProviderCredentialResolver;

const ROW = {
  id: 'p1',
  slug: 'anthropic',
  name: 'Anthropic',
  providerType: 'anthropic',
  apiKeyEnvVar: 'CRED_FAIL_TEST_KEY',
  isLocal: false,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  resetProviderCredentialResolver();
  process.env.CRED_FAIL_TEST_KEY = 'from-env';
});

describe('a fork init that throws', () => {
  it('is rolled back and logged by the shared gate', () => {
    expect(hasProviderCredentialResolver()).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('provider-credentials: initAppProviderCredentials threw'),
      expect.anything()
    );
  });

  it('refuses every credential instead of falling back to the env var', async () => {
    await expect(resolveProviderCredential(ROW)).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    await expect(hasProviderCredential(ROW)).resolves.toBe(false);
    // A local row too: it is resolved through the same seam.
    await expect(
      hasProviderCredential({ ...ROW, isLocal: true, apiKeyEnvVar: null })
    ).resolves.toBe(false);
  });
});
