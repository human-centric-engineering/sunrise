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
 * And the mixed pages (§111 t-812): the routes behind an org admin's half of
 * the dashboard, costs, analytics and executions answer them, and the routes
 * behind the platform-ops half refuse them before reaching any table.
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
vi.mock('@/lib/orchestration/admin/global-config-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/admin/global-config-usage')>()),
  capabilityAgentUsage: vi.fn(),
  knowledgeTagCounts: vi.fn(),
  agentProfileUsage: vi.fn(),
}));
vi.mock('@/lib/orchestration/mcp/config', () => ({
  getMcpServerConfig: vi.fn().mockResolvedValue({ globalRateLimit: 60 }),
  invalidateMcpConfigCache: vi.fn(),
}));
vi.mock('@/lib/orchestration/llm/model-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/model-registry')>()),
  refreshFromOpenRouter: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/orchestration/llm/spend-caps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/spend-caps')>()),
  getGlobalCapState: vi.fn(),
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
import { refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import { getGlobalCapState } from '@/lib/orchestration/llm/spend-caps';
import { GET as costBreakdown } from '@/app/api/v1/admin/orchestration/costs/route';
import { GET as costSummary } from '@/app/api/v1/admin/orchestration/costs/summary/route';
import { GET as costAlerts } from '@/app/api/v1/admin/orchestration/costs/alerts/route';
import { GET as costOrgs } from '@/app/api/v1/admin/orchestration/costs/orgs/route';
import { GET as modelList } from '@/app/api/v1/admin/orchestration/models/route';
import { GET as dashboardStats } from '@/app/api/v1/admin/orchestration/observability/dashboard-stats/route';
import { GET as activeQuarantines } from '@/app/api/v1/admin/orchestration/observability/active-quarantines/route';
import { GET as contentGaps } from '@/app/api/v1/admin/orchestration/analytics/content-gaps/route';
import { GET as engagement } from '@/app/api/v1/admin/orchestration/analytics/engagement/route';
import { GET as feedback } from '@/app/api/v1/admin/orchestration/analytics/feedback/route';
import { GET as topics } from '@/app/api/v1/admin/orchestration/analytics/topics/route';
import { GET as unanswered } from '@/app/api/v1/admin/orchestration/analytics/unanswered/route';
import { GET as liveEngine } from '@/app/api/v1/admin/orchestration/executions/live/route';
import { GET as executionCounts } from '@/app/api/v1/admin/orchestration/executions/counts/route';
import { GET as executionLease } from '@/app/api/v1/admin/orchestration/executions/[id]/lease/route';
import { POST as forceFail } from '@/app/api/v1/admin/orchestration/executions/[id]/force-fail/route';
import * as mcpSettings from '@/app/api/v1/admin/orchestration/mcp/settings/route';
import { GET as mcpTools } from '@/app/api/v1/admin/orchestration/mcp/tools/route';
import { GET as mcpResources } from '@/app/api/v1/admin/orchestration/mcp/resources/route';
import { GET as mcpPrompts } from '@/app/api/v1/admin/orchestration/mcp/prompts/route';
import { GET as orchestrationSettings } from '@/app/api/v1/admin/orchestration/settings/route';
import { GET as adminStats } from '@/app/api/v1/admin/stats/route';
import {
  agentProfileUsage,
  capabilityAgentUsage,
  knowledgeTagCounts,
} from '@/lib/orchestration/admin/global-config-usage';

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
  vi.mocked(capabilityAgentUsage).mockResolvedValue(new Map());
  vi.mocked(knowledgeTagCounts).mockResolvedValue(new Map());
  vi.mocked(agentProfileUsage).mockResolvedValue(new Map());
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

describe('an ADMIN of a customer org, at multi: other orgs’ usage of shared rows (§111 t-811 code review)', () => {
  const CAP = { id: 'cap-1', name: 'Search', slug: 'search', isActive: true };

  it('sees no other org’s agent count on a capability, though other orgs use it', async () => {
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([CAP] as never);
    vi.mocked(capabilityAgentUsage).mockResolvedValue(
      new Map([['cap-1', { agents: [], otherOrgAgents: 7 }]])
    );

    const body = (await (await capabilities.GET(get('/capabilities'))).json()) as {
      data: { _otherOrgAgentCount: number }[];
    };

    expect(body.data).toHaveLength(1);
    expect(body.data[0]._otherOrgAgentCount).toBe(0);
  });

  it('control: a platform admin sees it', async () => {
    signIn('ADMIN', ORG_B);
    vi.mocked(prisma.aiCapability.findMany).mockResolvedValue([CAP] as never);
    vi.mocked(capabilityAgentUsage).mockResolvedValue(
      new Map([['cap-1', { agents: [], otherOrgAgents: 7 }]])
    );

    const body = (await (await capabilities.GET(get('/capabilities'))).json()) as {
      data: { _otherOrgAgentCount: number }[];
    };

    expect(body.data[0]._otherOrgAgentCount).toBe(7);
  });

  it('has the tag and profile lists counted in their own org only', async () => {
    vi.mocked(prisma.knowledgeTag.findMany).mockResolvedValue([{ id: 'tag-1' }] as never);
    vi.mocked(prisma.aiAgentProfile.findMany).mockResolvedValue([{ id: 'prof-1' }] as never);

    await tags.GET(get('/knowledge/tags'));
    await agentProfiles.GET(get('/agent-profiles'));

    expect(knowledgeTagCounts).toHaveBeenCalledWith(['tag-1'], { acrossOrgs: false });
    expect(agentProfileUsage).toHaveBeenCalledWith(['prof-1'], { acrossOrgs: false });
  });

  it('control: a platform admin’s lists count every org', async () => {
    signIn('ADMIN', ORG_B);
    vi.mocked(prisma.knowledgeTag.findMany).mockResolvedValue([{ id: 'tag-1' }] as never);
    vi.mocked(prisma.aiAgentProfile.findMany).mockResolvedValue([{ id: 'prof-1' }] as never);

    await tags.GET(get('/knowledge/tags'));
    await agentProfiles.GET(get('/agent-profiles'));

    // Called as before this task: every org, the default.
    expect(knowledgeTagCounts).toHaveBeenCalledWith(['tag-1']);
    expect(agentProfileUsage).toHaveBeenCalledWith(['prof-1']);
  });
});

describe('an ADMIN of a customer org, at multi: the mixed pages (§111 t-812)', () => {
  const ADMIN_BASE = 'http://localhost:3000/api/v1/admin';
  const RANGE = 'dateFrom=2026-10-01&dateTo=2026-10-15&groupBy=model';
  const execParams = { params: Promise.resolve({ id: PROVIDER_ID }) };

  beforeEach(() => {
    vi.mocked(getGlobalCapState).mockResolvedValue({ cap: 500, spent: 120, exceeded: true });
  });

  /** The routes behind the org's half of the dashboard, costs and analytics. */
  const ORG_HALF = [
    { name: 'cost breakdown', call: () => costBreakdown(get(`/costs?${RANGE}`)) },
    { name: 'cost summary', call: () => costSummary(get('/costs/summary')) },
    { name: 'budget alerts', call: () => costAlerts(get('/costs/alerts')) },
    { name: 'model catalogue', call: () => modelList(get('/models')) },
    {
      name: 'dashboard stats',
      call: () => dashboardStats(get('/observability/dashboard-stats')),
    },
    { name: 'analytics content gaps', call: () => contentGaps(get('/analytics/content-gaps')) },
    { name: 'analytics engagement', call: () => engagement(get('/analytics/engagement')) },
    { name: 'analytics feedback', call: () => feedback(get('/analytics/feedback')) },
    { name: 'analytics topics', call: () => topics(get('/analytics/topics')) },
    { name: 'analytics unanswered', call: () => unanswered(get('/analytics/unanswered')) },
  ];

  /** The routes behind the platform-ops half: none declares a tier. */
  const PLATFORM_HALF = [
    { name: 'each org’s usage', call: () => costOrgs(get('/costs/orgs')) },
    {
      name: 'capability quarantines',
      call: () => activeQuarantines(get('/observability/active-quarantines')),
    },
    { name: 'live engine snapshot', call: () => liveEngine(get('/executions/live')) },
    { name: 'execution counts', call: () => executionCounts(get('/executions/counts')) },
    {
      name: 'lease inspector',
      call: () => executionLease(get(`/executions/${PROVIDER_ID}/lease`), execParams),
    },
    {
      name: 'force-fail',
      call: () => forceFail(post(`/executions/${PROVIDER_ID}/force-fail`, {}), execParams),
    },
    { name: 'MCP settings', call: () => mcpSettings.GET(get('/mcp/settings')) },
    {
      name: 'MCP server toggle',
      call: () =>
        mcpSettings.PATCH(
          new NextRequest(`${BASE}/mcp/settings`, {
            method: 'PATCH',
            body: JSON.stringify({ isEnabled: false }),
            headers: { 'Content-Type': 'application/json' },
          })
        ),
    },
    { name: 'MCP tools', call: () => mcpTools(get('/mcp/tools')) },
    { name: 'MCP resources', call: () => mcpResources(get('/mcp/resources')) },
    { name: 'MCP prompts', call: () => mcpPrompts(get('/mcp/prompts')) },
    { name: 'orchestration settings', call: () => orchestrationSettings(get('/settings')) },
    {
      name: 'the overview’s stats',
      call: () => adminStats(new NextRequest(`${ADMIN_BASE}/stats`)),
    },
  ];

  it.each(ORG_HALF)('reads the $name', async ({ call }) => {
    const res = await call();

    expect(res.status).toBe(200);
    expect(((await res.json()) as { success: boolean }).success).toBe(true);
  });

  it.each(PLATFORM_HALF)('is refused the $name, which never reaches a table', async ({ call }) => {
    const res = await call();

    expect(res.status).toBe(403);
    // The only read is the guard's own membership lookup.
    expect(calls.filter((c) => !c.startsWith('orgMembership.'))).toEqual([]);
  });

  it('control: a platform admin in the install org reaches the platform-ops half', async () => {
    // The install org: in a customer org a platform admin is refused each
    // org's usage and shared-settings writes too, by rules older than this.
    signIn('ADMIN', INSTALL_ORG_ID);
    for (const { call } of PLATFORM_HALF) {
      expect((await call()).status).not.toBe(403);
    }
  });

  it('control: a MEMBER of the same org is refused the org’s half too', async () => {
    membership.role = 'MEMBER';
    for (const { call } of ORG_HALF) {
      expect((await call()).status).toBe(403);
    }
  });

  it('is told the global cap is exceeded, and neither the cap nor anyone’s spend', async () => {
    const body = (await (await costAlerts(get('/costs/alerts'))).json()) as {
      data: { globalCap: { cap: number | null; spent: number | null; exceeded: boolean } };
    };

    expect(body.data.globalCap).toEqual({ cap: null, spent: null, exceeded: true });
  });

  it('control: a platform admin in the same org is given the cap', async () => {
    signIn('ADMIN', ORG_B);
    const body = (await (await costAlerts(get('/costs/alerts'))).json()) as {
      data: { globalCap: { cap: number | null; exceeded: boolean } };
    };

    // The spend stays the install org's to see (`getGlobalCapStatus`); the cap is theirs.
    expect(body.data.globalCap).toMatchObject({ cap: 500, exceeded: true });
  });

  it('is refused a forced refresh of the model catalogue, which never calls out', async () => {
    const res = await modelList(get('/models?refresh=true'));

    expect(res.status).toBe(403);
    expect(refreshFromOpenRouter).not.toHaveBeenCalled();
  });

  it('control: a platform admin may force one', async () => {
    signIn('ADMIN', ORG_B);
    const res = await modelList(get('/models?refresh=true'));

    expect(res.status).toBe(200);
    expect(refreshFromOpenRouter).toHaveBeenCalledWith({ force: true });
  });
});
