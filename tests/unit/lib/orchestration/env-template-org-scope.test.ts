/**
 * Tests: whose env vars an org's configs may name (§111 t-811)
 *
 * The process environment is the platform operator's. Once an org admin can
 * author outbound configs, a `${env:NAME}` template or an auth secret name is
 * a way to read any of it. At `multi`, a customer org may name only env vars
 * under its own `ORG_<ORG ID>_` prefix; the install org, a platform scope
 * with no org, and every install at `single` name anything, as before.
 *
 * Checked where the value is read — `resolveEnvTemplate`, and `readSecret`
 * behind `applyAuth` — so it holds whichever write path stored the config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (t, k) => (k === 'TENANCY_MODE' ? mockEnv.TENANCY_MODE : Reflect.get(t, k)),
    }),
  };
});
vi.mock('@/lib/logging', () => {
  const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  return { logger: { ...log, withContext: vi.fn(() => log) } };
});

const findBinding = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({ prisma: { aiAgentCapability: { findFirst: findBinding } } }));

import {
  EnvTemplateError,
  envVarAvailableHere,
  bindingEnvVarWarnings,
  classifyEnvVarReferences,
  findUnsetEnvVarReferences,
  orgEnvVarPrefix,
  resolveEnvTemplate,
} from '@/lib/orchestration/env-template';
import { applyAuth } from '@/lib/orchestration/http/auth';
import { HttpError } from '@/lib/orchestration/http/errors';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { CallExternalApiCapability } from '@/lib/orchestration/capabilities/built-in/call-external-api';
import { resetAllowlistCache } from '@/lib/orchestration/http/allowlist';

const ORG_A = 'cmorg0000000000000000orga';
const ORG_B = 'cmorg0000000000000000orgb';
const PLATFORM_SECRET = 'T811_PLATFORM_SECRET';
const B_SECRET = `${orgEnvVarPrefix(ORG_B)}WEBHOOK`;
const A_SECRET = `${orgEnvVarPrefix(ORG_A)}WEBHOOK`;

const inOrg = <T>(orgId: string, fn: () => T): Promise<T> =>
  runAsOrg(orgId, () => Promise.resolve().then(fn));

beforeEach(() => {
  mockEnv.TENANCY_MODE = 'multi';
  process.env[PLATFORM_SECRET] = 'operator-value';
  process.env[B_SECRET] = 'b-value';
  process.env[A_SECRET] = 'a-value';
});

afterEach(() => {
  delete process.env[PLATFORM_SECRET];
  delete process.env[B_SECRET];
  delete process.env[A_SECRET];
});

describe('orgEnvVarPrefix', () => {
  it('is ORG_, the org id upper-cased, and _ — a valid env-var name stem', () => {
    expect(orgEnvVarPrefix(ORG_B)).toBe('ORG_CMORG0000000000000000ORGB_');
    expect(/^[A-Z][A-Z0-9_]*$/.test(orgEnvVarPrefix(ORG_B))).toBe(true);
  });
});

describe('resolveEnvTemplate in a customer org at multi', () => {
  it('refuses the operator’s env var, without resolving it', async () => {
    const attempt = inOrg(ORG_B, () =>
      resolveEnvTemplate(`https://h.example/x?k=\${env:${PLATFORM_SECRET}}`)
    );

    await expect(attempt).rejects.toBeInstanceOf(EnvTemplateError);
    await expect(attempt).rejects.toMatchObject({
      code: 'env_var_not_available',
      envVarName: PLATFORM_SECRET,
    });
    await expect(attempt).rejects.not.toThrow(/operator-value/);
  });

  it('refuses the same way whether or not the operator’s variable is set — no probing', async () => {
    delete process.env[PLATFORM_SECRET];
    await expect(
      inOrg(ORG_B, () => resolveEnvTemplate(`\${env:${PLATFORM_SECRET}}`))
    ).rejects.toMatchObject({ code: 'env_var_not_available' });
  });

  it('resolves a name under its own prefix', async () => {
    await expect(
      inOrg(ORG_B, () => resolveEnvTemplate(`Bearer \${env:${B_SECRET}}`))
    ).resolves.toBe('Bearer b-value');
  });

  it('refuses another org’s prefix', async () => {
    await expect(
      inOrg(ORG_B, () => resolveEnvTemplate(`\${env:${A_SECRET}}`))
    ).rejects.toMatchObject({ code: 'env_var_not_available' });
  });
});

describe('who names anything, as before', () => {
  it('the install org at multi', async () => {
    await expect(
      inOrg(INSTALL_ORG_ID, () => resolveEnvTemplate(`\${env:${PLATFORM_SECRET}}`))
    ).resolves.toBe('operator-value');
  });

  it('a system scope at multi', async () => {
    await expect(
      runAsSystem('test: a platform job', () =>
        Promise.resolve(resolveEnvTemplate(`\${env:${PLATFORM_SECRET}}`))
      )
    ).resolves.toBe('operator-value');
  });

  it('but NO context at all at multi names nothing — it is a bug, and fails closed', () => {
    expect(envVarAvailableHere(PLATFORM_SECRET)).toBe(false);
    expect(() => resolveEnvTemplate(`\${env:${PLATFORM_SECRET}}`)).toThrow(
      /no organisation is in context/
    );
  });

  it('any org at single', async () => {
    mockEnv.TENANCY_MODE = 'single';
    await expect(
      inOrg(ORG_B, () => resolveEnvTemplate(`\${env:${PLATFORM_SECRET}}`))
    ).resolves.toBe('operator-value');
  });
});

describe('findUnsetEnvVarReferences — the save-time warning', () => {
  it('never looks up a name the org may not use, set or not — no probing', async () => {
    const missing = await inOrg(ORG_B, () =>
      findUnsetEnvVarReferences(`\${env:${PLATFORM_SECRET}}`, {
        Authorization: `\${env:${B_SECRET}}`,
      })
    );
    expect(missing).toEqual([]);
    delete process.env[PLATFORM_SECRET];
    await expect(
      inOrg(ORG_B, () => findUnsetEnvVarReferences(`\${env:${PLATFORM_SECRET}}`))
    ).resolves.toEqual([]);
  });

  it('reports it as unavailable instead, with the prefix that would fix it', async () => {
    const classes = await inOrg(ORG_B, () =>
      classifyEnvVarReferences(`\${env:${PLATFORM_SECRET}}`, {
        Authorization: `\${env:${B_SECRET}}`,
      })
    );
    expect(classes).toEqual({
      missing: [],
      unavailable: [PLATFORM_SECRET],
      prefix: orgEnvVarPrefix(ORG_B),
    });
  });

  it('control: the install org has no unavailable names and no prefix', async () => {
    const classes = await inOrg(INSTALL_ORG_ID, () =>
      classifyEnvVarReferences(`\${env:${PLATFORM_SECRET}}`, '${env:T811_NOT_SET}')
    );
    expect(classes).toEqual({ missing: ['T811_NOT_SET'], unavailable: [], prefix: null });
  });

  it('bindingEnvVarWarnings — the save warning: both lists, the prefix, or nothing', async () => {
    const warn = await inOrg(ORG_B, () =>
      bindingEnvVarWarnings({
        forcedUrl: `https://h.example/\${env:${PLATFORM_SECRET}}`,
        forcedHeaders: { 'X-A': `\${env:${orgEnvVarPrefix(ORG_B)}UNSET}` },
      })
    );
    expect(warn).toEqual({
      missingEnvVars: [`${orgEnvVarPrefix(ORG_B)}UNSET`],
      unavailableEnvVars: [PLATFORM_SECRET],
      envVarPrefix: orgEnvVarPrefix(ORG_B),
    });
    expect(
      await inOrg(ORG_B, () => bindingEnvVarWarnings({ forcedUrl: 'https://h.example/' }))
    ).toBeNull();
    expect(bindingEnvVarWarnings({ forcedUrl: 42 })).toBeNull();
  });

  it('control: the install org sees the operator’s variable as set', async () => {
    const missing = await inOrg(INSTALL_ORG_ID, () =>
      findUnsetEnvVarReferences(`\${env:${PLATFORM_SECRET}}`)
    );
    expect(missing).toEqual([]);
  });
});

describe('applyAuth — an auth secret named by env var', () => {
  const auth = (secret: string) => ({ type: 'bearer' as const, secret });

  it('refuses the operator’s variable in a customer org, before reading it', async () => {
    const attempt = inOrg(ORG_B, () =>
      applyAuth(auth(PLATFORM_SECRET), 'https://h.example', 'GET', '')
    );

    await expect(attempt).rejects.toBeInstanceOf(HttpError);
    await expect(attempt).rejects.toMatchObject({ code: 'auth_secret_not_available' });
    await expect(attempt).rejects.not.toThrow(/operator-value/);
  });

  it('sends a secret under the org’s own prefix', async () => {
    const out = await inOrg(ORG_B, () => applyAuth(auth(B_SECRET), 'https://h.example', 'GET', ''));
    expect(out.headers.Authorization).toBe('Bearer b-value');
  });

  it('control: the install org still sends the operator’s variable', async () => {
    const out = await inOrg(INSTALL_ORG_ID, () =>
      applyAuth(auth(PLATFORM_SECRET), 'https://h.example', 'GET', '')
    );
    expect(out.headers.Authorization).toBe('Bearer operator-value');
  });
});

describe('call_external_api — the path an org admin can author and trigger', () => {
  const context = { userId: 'user-b', agentId: 'agent-b' };

  beforeEach(() => {
    process.env.ORCHESTRATION_ALLOWED_HOSTS = 'api.allowed.com';
    resetAllowlistCache();
  });
  afterEach(() => {
    delete process.env.ORCHESTRATION_ALLOWED_HOSTS;
    resetAllowlistCache();
    vi.restoreAllMocks();
  });

  it.each([
    [
      'a forcedUrl template',
      { forcedUrl: `https://api.allowed.com/x?k=\${env:${PLATFORM_SECRET}}` },
    ],
    ['a forcedHeaders template', { forcedHeaders: { 'X-Leak': `\${env:${PLATFORM_SECRET}}` } }],
    ['an auth secret name', { auth: { type: 'bearer', secret: PLATFORM_SECRET } }],
  ])(
    'refuses %s naming the operator’s variable in org B, and sends nothing',
    async (_label, customConfig) => {
      findBinding.mockResolvedValue({ customConfig });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'));

      const result = await inOrg(ORG_B, () =>
        new CallExternalApiCapability().execute(
          { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
          context
        )
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
      expect(JSON.stringify(result)).not.toContain('operator-value');
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  );

  it('control: the same bearer binding in the install org sends the operator’s variable', async () => {
    findBinding.mockResolvedValue({
      customConfig: { auth: { type: 'bearer', secret: PLATFORM_SECRET } },
    });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { headers: { 'Content-Type': 'application/json' } }));

    const result = await inOrg(INSTALL_ORG_ID, () =>
      new CallExternalApiCapability().execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        context
      )
    );

    expect(result.success).toBe(true);
    const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer operator-value');
  });
});
