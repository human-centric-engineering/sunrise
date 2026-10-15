/**
 * Integration Test: what an org admin may do with shared configuration (§111 t-811)
 *
 * Ruling 3 on §111: an org-tier section that needs platform config reads it,
 * and never writes it. So an ADMIN of a customer org, at `multi`, reads the
 * capability, agent-profile, provider and tag lists (the agent form and the
 * knowledge pages depend on them) and is refused each one's write.
 *
 * And the agent form's provider test: an org admin may test only a provider
 * their org is approved for, and the vendor call runs in their org. A platform
 * admin keeps the install-org probe that lets them test before granting.
 *
 * The guards, the policy and the route handlers are real; the database is a
 * stub that answers every read with nothing. That proves admission, which is
 * what these tests are for; which ROWS an org admin gets is
 * `scripts/smoke/tenancy-isolation.ts`'s, against Postgres with RLS.
 *
 * @see lib/auth/admin-tier.ts — the roster
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_ADMIN_ROLE } from '@/lib/tenancy/roles';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, TENANCY_MODE: 'multi' } };
});

/**
 * Every model answers every read with nothing and records every call, so a
 * refused write can be shown not to have reached the database. The membership
 * read is the one answer that matters: it is what makes the caller an org
 * ADMIN of the org their session names.
 */
const calls = vi.hoisted(() => [] as string[]);
const membership = vi.hoisted(() => ({ role: 'ADMIN', org: { status: 'ACTIVE' } }));
vi.mock('@/lib/db/client', () => {
  const empty = (op: string): unknown => {
    if (op === 'count') return 0;
    if (op.startsWith('find') && !op.startsWith('findMany')) return null;
    if (op === 'aggregate') return { _sum: {}, _count: 0 };
    return [];
  };
  // One mock per model and operation, kept, so a test can override one. The
  // default implementation records the call; an override answers instead.
  const fns = new Map<string, ReturnType<typeof vi.fn>>();
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => {
          const key = `${name}.${op}`;
          if (!fns.has(key)) {
            fns.set(
              key,
              vi.fn((..._args: unknown[]) => {
                calls.push(key);
                if (name === 'orgMembership' && op === 'findUnique') {
                  return Promise.resolve(membership);
                }
                return Promise.resolve(empty(op));
              })
            );
          }
          return fns.get(key);
        },
      }
    );
  const prisma = new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (name === '$queryRaw' || name === '$queryRawUnsafe') return vi.fn(() => []);
        if (name === '$transaction') {
          return vi.fn((arg: unknown) =>
            Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma)
          );
        }
        return model(name);
      },
    }
  );
  return { prisma };
});

vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/logging', () => {
  const log = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
  return { logger: { ...log, withContext: vi.fn(() => log) } };
});
vi.mock('@/lib/orchestration/llm/provider-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/provider-manager')>()),
  getProvider: vi.fn(),
  testProvider: vi.fn(),
}));
vi.mock('@/lib/orchestration/mcp/config', () => ({
  getMcpServerConfig: vi.fn().mockResolvedValue({ globalRateLimit: 60 }),
  invalidateMcpConfigCache: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/org-provider-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/org-provider-policy')>()),
  unapprovedProviders: vi.fn(),
}));

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { getTenantContext } from '@/lib/tenancy/context';
import { getProvider, testProvider } from '@/lib/orchestration/llm/provider-manager';
import { unapprovedProviders } from '@/lib/orchestration/llm/org-provider-policy';
import * as capabilities from '@/app/api/v1/admin/orchestration/capabilities/route';
import * as agentProfiles from '@/app/api/v1/admin/orchestration/agent-profiles/route';
import * as providers from '@/app/api/v1/admin/orchestration/providers/route';
import * as tags from '@/app/api/v1/admin/orchestration/knowledge/tags/route';
import { POST as testConnection } from '@/app/api/v1/admin/orchestration/providers/[id]/test/route';
import { POST as testModel } from '@/app/api/v1/admin/orchestration/providers/[id]/test-model/route';
import { POST as testWebhook } from '@/app/api/v1/admin/orchestration/webhooks/[id]/test/route';
import { POST as createMcpKey } from '@/app/api/v1/admin/orchestration/mcp/keys/route';

const ORG_B = 'cmorg0000000000000000orgb';
const PROVIDER_ID = 'cmjbv4i3x00003wsloputgwul';
const BASE = 'http://localhost:3000/api/v1/admin/orchestration';

function signIn(role: 'USER' | 'ADMIN', activeOrgId: string): void {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 'session_1',
      userId: 'user_b',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      activeOrgId,
    },
    user: {
      id: 'user_b',
      name: 'Org B admin',
      email: 'b@example.com',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
}

const get = (path: string) => new NextRequest(`${BASE}${path}`);
const post = (path: string, body: unknown) =>
  new NextRequest(`${BASE}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
const params = { params: Promise.resolve({ id: PROVIDER_ID }) };

/** The four shared-config lists the org-tier sections read, and each one's write. */
const SHARED = [
  {
    name: 'capabilities',
    list: () => capabilities.GET(get('/capabilities')),
    write: () => capabilities.POST(post('/capabilities', { name: 'x' })),
    model: 'aiCapability',
  },
  {
    name: 'agent profiles',
    list: () => agentProfiles.GET(get('/agent-profiles')),
    write: () => agentProfiles.POST(post('/agent-profiles', { name: 'x' })),
    model: 'aiAgentProfile',
  },
  {
    name: 'providers',
    list: () => providers.GET(get('/providers')),
    write: () => providers.POST(post('/providers', { name: 'x' })),
    model: 'aiProviderConfig',
  },
  {
    name: 'knowledge tags',
    list: () => tags.GET(get('/knowledge/tags')),
    write: () => tags.POST(post('/knowledge/tags', { name: 'x' })),
    model: 'knowledgeTag',
  },
] as const;

const PROVIDER_ROW = {
  id: PROVIDER_ID,
  name: 'Anthropic',
  slug: 'anthropic',
  providerType: 'anthropic',
  isActive: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  membership.role = ORG_ADMIN_ROLE;
  signIn('USER', ORG_B);
});

describe('an ADMIN of a customer org, at multi: shared configuration', () => {
  it.each(SHARED)('reads the $name list', async ({ list, model }) => {
    const res = await list();
    const body = (await res.json()) as { success: boolean };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // The handler ran and read the table — not a cached or short-circuited answer.
    expect(calls.some((c) => c.startsWith(`${model}.find`))).toBe(true);
  });

  it.each(SHARED)(
    'is refused the $name write, which never reaches the table',
    async ({ write, model }) => {
      const res = await write();

      expect(res.status).toBe(403);
      expect(calls.filter((c) => c.startsWith(`${model}.`))).toEqual([]);
    }
  );

  it('control: a MEMBER of the same org is refused the reads too — the tier admits admins only', async () => {
    membership.role = 'MEMBER';
    for (const { list } of SHARED) {
      expect((await list()).status).toBe(403);
    }
  });
});

describe('an ADMIN of a customer org, at multi: testing a provider from the agent form', () => {
  beforeEach(() => {
    vi.mocked(prisma.aiProviderConfig.findUnique).mockResolvedValue(PROVIDER_ROW as never);
  });

  it('is refused a provider their org is not approved for, before any vendor call', async () => {
    vi.mocked(unapprovedProviders).mockResolvedValue(['anthropic']);

    const conn = await testConnection(post(`/providers/${PROVIDER_ID}/test`, {}), params);
    const model = await testModel(
      post(`/providers/${PROVIDER_ID}/test-model`, { model: 'claude-x' }),
      params
    );

    expect(await conn.json()).toMatchObject({
      success: true,
      data: { ok: false, error: 'provider_not_approved' },
    });
    expect(await model.json()).toMatchObject({
      success: true,
      data: { ok: false, error: 'provider_not_approved' },
    });
    expect(unapprovedProviders).toHaveBeenCalledWith(['anthropic']);
    expect(testProvider).not.toHaveBeenCalled();
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('tests an approved provider, and the vendor call runs in their org, not the install org', async () => {
    vi.mocked(unapprovedProviders).mockResolvedValue([]);
    const ranIn: (string | null | undefined)[] = [];
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn(() => {
        ranIn.push(getTenantContext()?.orgId);
        return Promise.resolve({ content: 'Hello.' });
      }),
    } as never);

    const res = await testModel(
      post(`/providers/${PROVIDER_ID}/test-model`, { model: 'claude-x' }),
      params
    );

    expect(await res.json()).toMatchObject({ success: true, data: { ok: true } });
    expect(ranIn).toEqual([ORG_B]);
  });

  it('control: a platform admin in the same org skips the approval check and probes as the install org', async () => {
    signIn('ADMIN', ORG_B);
    const ranIn: (string | null | undefined)[] = [];
    vi.mocked(getProvider).mockResolvedValue({
      chat: vi.fn(() => {
        ranIn.push(getTenantContext()?.orgId);
        return Promise.resolve({ content: 'Hello.' });
      }),
    } as never);

    const res = await testModel(
      post(`/providers/${PROVIDER_ID}/test-model`, { model: 'claude-x' }),
      params
    );

    expect(await res.json()).toMatchObject({ success: true, data: { ok: true } });
    expect(unapprovedProviders).not.toHaveBeenCalled();
    expect(ranIn).toEqual([INSTALL_ORG_ID]);
  });
});

describe('an ADMIN of a customer org, at multi: testing a webhook (§111 t-811 security review)', () => {
  it('sends the ping through the safe dispatcher, which checks where the host resolves', async () => {
    vi.mocked(prisma.aiWebhookSubscription.findFirst).mockResolvedValue({
      id: PROVIDER_ID,
      channel: 'webhook',
      url: 'https://hooks.example.com/in',
      secret: 'test-secret-key-1234567890',
      emailAddress: null,
    } as never);
    const fetchSpy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const res = await testWebhook(post(`/webhooks/${PROVIDER_ID}/test`, {}), params);

      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(init.dispatcher).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('an ADMIN of a customer org, at multi: the provider list (§111 t-811 code review)', () => {
  const row = {
    ...PROVIDER_ROW,
    baseUrl: 'http://10.0.0.7:11434',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    metadata: { region: 'internal' },
    isLocal: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('gets each provider without its endpoint, its key’s env var name or its metadata', async () => {
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([row] as never);
    const res = await providers.GET(get('/providers'));
    const body = (await res.json()) as { data: Record<string, unknown>[] };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ slug: 'anthropic', name: 'Anthropic' });
    expect(body.data[0]).not.toHaveProperty('baseUrl');
    expect(body.data[0]).not.toHaveProperty('apiKeyEnvVar');
    expect(body.data[0]).not.toHaveProperty('metadata');
  });

  it('control: a platform admin still gets the whole row', async () => {
    signIn('ADMIN', ORG_B);
    vi.mocked(prisma.aiProviderConfig.findMany).mockResolvedValue([row] as never);
    const res = await providers.GET(get('/providers'));
    const body = (await res.json()) as { data: Record<string, unknown>[] };

    expect(body.data[0]).toMatchObject({
      baseUrl: 'http://10.0.0.7:11434',
      apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    });
  });
});

describe('an ADMIN of a customer org, at multi: an MCP key’s rate limit (§111 t-811 code review)', () => {
  beforeEach(() => {
    vi.mocked(prisma.mcpApiKey.create).mockResolvedValue({
      id: 'k1',
      name: 'k',
      keyPrefix: 'smcp_xx',
      scopes: [],
      createdAt: new Date(),
    } as never);
  });

  it('is refused an override above the server’s limit, and nothing is created', async () => {
    const res = await createMcpKey(
      post('/mcp/keys', { name: 'k', scopes: ['tools:list'], rateLimitOverride: 10000 })
    );

    expect(res.status).toBe(400);
    expect(prisma.mcpApiKey.create).not.toHaveBeenCalled();
  });

  it('may lower a key below the server’s limit', async () => {
    const res = await createMcpKey(
      post('/mcp/keys', { name: 'k', scopes: ['tools:list'], rateLimitOverride: 30 })
    );

    expect(res.status).toBe(201);
    expect(prisma.mcpApiKey.create).toHaveBeenCalled();
  });

  it('control: a platform admin may raise it', async () => {
    signIn('ADMIN', ORG_B);
    const res = await createMcpKey(
      post('/mcp/keys', { name: 'k', scopes: ['tools:list'], rateLimitOverride: 10000 })
    );

    expect(res.status).toBe(201);
  });
});
