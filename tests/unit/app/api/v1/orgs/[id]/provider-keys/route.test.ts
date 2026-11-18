/**
 * Unit Tests: /api/v1/orgs/[id]/provider-keys (§137 t-1045)
 *
 * Runs the REAL `withAuth`, the REAL default policy, the REAL entry rule
 * (support sessions included), the REAL key store with REAL sealing, and the
 * REAL rate limiter. Prisma is mocked at the delegates, with the key table an
 * in-memory stand-in for the real one. Scripted per test: the install's
 * switch, which providers the org is approved for, and the vendor's answer to
 * the test call.
 *
 * Who reaches a handler is the policy's decision, asked about the resource
 * kind `org.providerKeys`, so it is under test rather than mocked; the last
 * block registers policies that widen and narrow it.
 *
 * "The key never leaves the server" is checked on every path that sees one:
 * the response, every log line and every audit entry are searched for it.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const envOverrides = vi.hoisted((): Record<string, string | undefined> => ({}));
vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, key) =>
        typeof key === 'string' && key in envOverrides
          ? envOverrides[key]
          : (Reflect.get(target, key) as unknown),
    }),
  };
});

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: mockGetSession } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

interface ProviderRow {
  id: string;
  name: string;
  slug: string;
  providerType: string;
  isLocal: boolean;
  isActive: boolean;
  baseUrl: string | null;
}

interface MockDb {
  org: { findUnique: Mock };
  orgMembership: { findUnique: Mock };
  aiApiKey: { findFirst: Mock; update: Mock };
  orgSupportGrant: { findFirst: Mock };
  aiProviderConfig: { findUnique: Mock; findMany: Mock };
  user: { findMany: Mock };
  $transaction: Mock;
}

const mockDb = vi.hoisted((): MockDb => ({
  org: { findUnique: vi.fn() },
  orgMembership: { findUnique: vi.fn() },
  aiApiKey: { findFirst: vi.fn(), update: vi.fn() },
  orgSupportGrant: { findFirst: vi.fn() },
  aiProviderConfig: { findUnique: vi.fn(), findMany: vi.fn() },
  user: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('@/lib/db/client', async () => ({
  prisma: {
    ...mockDb,
    aiOrgProviderKey: (await import('@/tests/helpers/org-provider-key-table')).orgKeyTable.delegate,
  },
}));

const mockAudit = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

const switchState = vi.hoisted(() => ({ on: true }));
vi.mock('@/lib/orchestration/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/settings')>()),
  getOrchestrationSettings: vi.fn(async () => ({ orgProviderKeysEnabled: switchState.on })),
}));

const approvals = vi.hoisted(() => ({ slugs: new Set<string>() }));
vi.mock('@/lib/orchestration/llm/org-provider-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/org-provider-policy')>()),
  applyOrgProviderPolicy: vi.fn(async (candidates: readonly string[]) =>
    candidates.filter((slug) => approvals.slugs.has(slug))
  ),
}));

const mockTestProviderKey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/orchestration/llm/provider-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/llm/provider-manager')>()),
  testProviderKey: mockTestProviderKey,
}));

import { GET } from '@/app/api/v1/orgs/[id]/provider-keys/route';
import { PUT, DELETE } from '@/app/api/v1/orgs/[id]/provider-keys/[providerId]/route';
import { POST as TEST } from '@/app/api/v1/orgs/[id]/provider-keys/[providerId]/test/route';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
} from '@/lib/auth/authorization';
import {
  orgProviderKeyPurpose,
  forgetOrgProviderKey,
} from '@/lib/orchestration/llm/org-provider-keys';
import { openSecret, sealSecret } from '@/lib/security/sealed-secrets';
import { providerKeyTestLimiter } from '@/lib/security/rate-limit';
import { createMockAuthSession } from '@/tests/helpers/auth';
import { orgKeyTable } from '@/tests/helpers/org-provider-key-table';

const ORG = 'cmorg000000000000000other';
const ELSEWHERE = 'cmorg00000000000000elsewh';
const GRANT = 'cmgrant00000000000000one';
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const KEY = 'sk-ant-org-own-0000000000000000000000000000wxyz';
const NEW_KEY = 'sk-ant-org-new-1111111111111111111111111111abcd';

const ANTHROPIC: ProviderRow = {
  id: 'cmprov000000000000anthropic',
  name: 'Anthropic',
  slug: 'anthropic',
  providerType: 'anthropic',
  isLocal: false,
  isActive: true,
  baseUrl: null,
};
const OPENAI: ProviderRow = {
  id: 'cmprov0000000000000000openai',
  name: 'OpenAI',
  slug: 'openai',
  providerType: 'openai-compatible',
  isLocal: false,
  isActive: true,
  baseUrl: 'https://api.openai.com/v1',
};
const OLLAMA: ProviderRow = {
  id: 'cmprov0000000000000000ollama',
  name: 'Ollama',
  slug: 'ollama-local',
  providerType: 'openai-compatible',
  isLocal: true,
  isActive: true,
  baseUrl: 'http://localhost:11434/v1',
};
/** The provider table, reset before each test; a test may change a row. */
let providers: ProviderRow[] = [];

function keyring(): void {
  envOverrides.SEALED_SECRET_KEYS = 'one:master-key-one-0123456789abcdefghijklmnop';
  envOverrides.SEALED_SECRET_ACTIVE_KEY = 'one';
}

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  const base = createMockAuthSession();
  return { session: { ...base.session, activeOrgId }, user: { ...base.user, role } };
}

/** An org member with this role, acting in `orgId`. */
function actingAs(orgRole: string, orgId = ORG): void {
  mockGetSession.mockResolvedValue(session('USER', orgId));
  mockDb.orgMembership.findUnique.mockResolvedValue({ role: orgRole, org: { status: 'ACTIVE' } });
}

/** A platform admin in the org under its support grant, at this level. */
function inSupportSession(level: 'ADMIN' | 'READ_ONLY' = 'ADMIN'): void {
  mockGetSession.mockResolvedValue(session('ADMIN', ORG));
  mockDb.orgMembership.findUnique.mockResolvedValue(null);
  mockDb.orgSupportGrant.findFirst.mockResolvedValue({
    id: GRANT,
    level,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

/** Save a key straight into the table, sealed for `ORG` and the row (or another purpose). */
async function storedKey(
  provider: ProviderRow,
  apiKey = KEY,
  sealedFor = orgProviderKeyPurpose(ORG, provider.id)
): Promise<void> {
  const id = `key-${provider.slug}`;
  orgKeyTable.rows.set(id, {
    id,
    orgId: ORG,
    providerConfigId: provider.id,
    sealedKey: await sealSecret(apiKey, sealedFor),
    version: 1,
    hint: apiKey.slice(-4),
    savedById: USER_ID,
    savedAt: new Date('2026-11-01T10:00:00Z'),
    createdAt: new Date('2026-11-01T10:00:00Z'),
  });
}

/** What the key table's `providerConfig` relation reads, from the provider table. */
function syncProviderRelation(): void {
  orgKeyTable.providers.clear();
  for (const row of providers) {
    orgKeyTable.providers.set(row.id, { name: row.name, slug: row.slug, isActive: row.isActive });
  }
}

/** Change one provider row, as platform staff would. */
function changeProvider(id: string, change: Partial<ProviderRow>): void {
  providers = providers.map((row) => (row.id === id ? { ...row, ...change } : row));
  syncProviderRelation();
}

const orgParams = (id = ORG) => ({ params: Promise.resolve({ id }) });
const keyParams = (providerId: string, id = ORG) => ({
  params: Promise.resolve({ id, providerId }),
});
const url = (orgId: string, rest = '') =>
  `http://localhost/api/v1/orgs/${orgId}/provider-keys${rest}`;

function list(orgId = ORG) {
  return GET(new Request(url(orgId)) as unknown as NextRequest, orgParams(orgId));
}

function save(providerId: string, apiKey: unknown = KEY, orgId = ORG) {
  const request = new Request(url(orgId, `/${providerId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey }),
  }) as unknown as NextRequest;
  return PUT(request, keyParams(providerId, orgId));
}

function remove(providerId: string, orgId = ORG) {
  const request = new Request(url(orgId, `/${providerId}`), {
    method: 'DELETE',
  }) as unknown as NextRequest;
  return DELETE(request, keyParams(providerId, orgId));
}

function test(providerId: string, orgId = ORG) {
  const request = new Request(url(orgId, `/${providerId}/test`), {
    method: 'POST',
  }) as unknown as NextRequest;
  return TEST(request, keyParams(providerId, orgId));
}

async function body(res: Response) {
  return JSON.parse(await res.text());
}

/** Everything that left the handler: every log line and every audit entry. */
function everythingLoggedOrAudited(): string {
  return JSON.stringify([
    mockLog.info.mock.calls,
    mockLog.warn.mock.calls,
    mockLog.error.mock.calls,
    mockLog.debug.mock.calls,
    mockAudit.mock.calls,
  ]);
}

function expectNoKeyAnywhere(responseText: string, ...keys: string[]): void {
  const logged = everythingLoggedOrAudited();
  for (const key of keys) {
    expect(responseText).not.toContain(key);
    expect(logged).not.toContain(key);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  orgKeyTable.clear();
  forgetOrgProviderKey();
  __resetAuthorizationPolicyForTests();
  for (const key of Object.keys(envOverrides)) delete envOverrides[key];
  envOverrides.TENANCY_MODE = 'multi';
  keyring();
  switchState.on = true;
  approvals.slugs = new Set(['anthropic', 'openai']);
  providerKeyTestLimiter.reset(`provider-key-save:org:${ORG}`);
  providerKeyTestLimiter.reset(`provider-key-test:org:${ORG}`);

  mockDb.aiApiKey.findFirst.mockResolvedValue(null);
  mockDb.orgSupportGrant.findFirst.mockResolvedValue(null);
  mockDb.org.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
    id: args.where.id,
    status: 'ACTIVE',
    name: 'Acme',
  }));
  mockDb.$transaction.mockImplementation(async (fn: (tx: MockDb) => unknown) => fn(mockDb));
  mockDb.aiProviderConfig.findUnique.mockImplementation(
    async (args: { where: { id: string } }) =>
      providers.find((row) => row.id === args.where.id) ?? null
  );
  mockDb.aiProviderConfig.findMany.mockImplementation(
    async (args: { where: { OR: [{ isActive: true }, { id: { in: string[] } }] } }) => {
      const keyed = new Set(args.where.OR[1].id.in);
      return providers.filter((row) => row.isActive || keyed.has(row.id));
    }
  );
  mockDb.user.findMany.mockResolvedValue([{ id: USER_ID, name: 'Ada Admin' }]);
  providers = [ANTHROPIC, OPENAI, OLLAMA];
  syncProviderRelation();
  mockTestProviderKey.mockResolvedValue({ ok: true, models: ['claude'] });
});

afterEach(() => {
  __resetAuthorizationPolicyForTests();
});

describe('GET — the org’s keys and their state', () => {
  it('lists each approved provider that takes a key, with the saved key’s hint, saver and state, and never the key', async () => {
    actingAs(ORG_OWNER_ROLE);
    await storedKey(ANTHROPIC);

    const res = await list();
    const text = await res.clone().text();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data).toEqual({
      orgId: ORG,
      saveBlocked: null,
      readOnly: false,
      providers: [
        {
          providerConfigId: ANTHROPIC.id,
          name: 'Anthropic',
          slug: 'anthropic',
          approved: true,
          takesKey: true,
          key: {
            hint: 'wxyz',
            version: 1,
            savedAt: '2026-11-01T10:00:00.000Z',
            savedBy: { id: USER_ID, name: 'Ada Admin' },
            state: 'in_use',
          },
        },
        // No key saved: the platform's key. Ollama is local and takes no key.
        {
          providerConfigId: OPENAI.id,
          name: 'OpenAI',
          slug: 'openai',
          approved: true,
          takesKey: true,
          key: null,
        },
      ],
    });
    expect(text).not.toContain('sealedKey');
    expectNoKeyAnywhere(text, KEY, orgKeyTable.get(ORG, ANTHROPIC.id)!.sealedKey);
  });

  it('reports a key as switched off, and saving as blocked, while own keys are switched off', async () => {
    actingAs(ORG_ADMIN_ROLE);
    switchState.on = false;
    await storedKey(ANTHROPIC);

    const json = await body(await list());

    expect(json.data.saveBlocked).toBe('switched_off');
    expect(json.data.providers[0].key.state).toBe('switched_off');
  });

  it('lists a saved key for a provider the org is no longer approved for, as not approved', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(OPENAI);
    approvals.slugs = new Set(['anthropic']);

    const json = await body(await list());

    expect(
      json.data.providers.map((p: { slug: string; approved: boolean; key: unknown }) => [
        p.slug,
        p.approved,
        (p.key as { state: string } | null)?.state ?? null,
      ])
    ).toEqual([
      ['anthropic', true, null],
      ['openai', false, 'not_approved'],
    ]);
  });

  it('reports a key that will not open — sealed for another org — as will not open', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC, KEY, orgProviderKeyPurpose(ELSEWHERE, ANTHROPIC.id));

    const json = await body(await list());

    expect(json.data.providers[0].key.state).toBe('will_not_open');
  });

  it('lists a key for a provider platform staff switched off, as provider off, and offers no save or test for it', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(OPENAI);
    changeProvider(OPENAI.id, { isActive: false });

    const json = await body(await list());
    const openai = json.data.providers.find((p: { slug: string }) => p.slug === 'openai');

    expect(openai).toEqual(
      expect.objectContaining({
        takesKey: false,
        key: expect.objectContaining({ state: 'provider_off' }),
      })
    );
    expect((await test(OPENAI.id)).status).toBe(404);
    expect((await remove(OPENAI.id)).status).toBe(200);
  });

  it('keeps listing a key for a provider that has since become local, so it can be removed', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(OPENAI);
    changeProvider(OPENAI.id, { isLocal: true });

    const json = await body(await list());
    const openai = json.data.providers.find((p: { slug: string }) => p.slug === 'openai');

    expect(openai).toEqual(expect.objectContaining({ takesKey: false, key: expect.anything() }));
    // An inactive provider without a key is not listed at all.
    changeProvider(ANTHROPIC.id, { isActive: false });
    const after = await body(await list());
    expect(after.data.providers.map((p: { slug: string }) => p.slug)).toEqual(['openai']);
  });

  it('refuses every verb on an install with one organisation, where no org’s key is used', async () => {
    actingAs(ORG_OWNER_ROLE);
    envOverrides.TENANCY_MODE = 'single';

    for (const res of [
      await list(),
      await save(ANTHROPIC.id),
      await test(ANTHROPIC.id),
      await remove(ANTHROPIC.id),
    ]) {
      expect(res.status).toBe(409);
      expect((await body(res)).error.details).toEqual({ reason: 'single_tenant' });
    }
    expect(mockTestProviderKey).not.toHaveBeenCalled();
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('blocks saving when no master key is configured', async () => {
    actingAs(ORG_ADMIN_ROLE);
    delete envOverrides.SEALED_SECRET_KEYS;
    delete envOverrides.SEALED_SECRET_ACTIVE_KEY;

    const json = await body(await list());

    expect(json.data.saveBlocked).toBe('master_key_missing');
  });

  it('shows a support session the keys, with saving blocked for it', async () => {
    inSupportSession();
    await storedKey(ANTHROPIC);

    const res = await list();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data.saveBlocked).toBe('support_session');
    expect(json.data.providers[0].key.state).toBe('in_use');
    expect(json.data.readOnly).toBe(false);
  });

  it('marks a read-only support session read-only, so the page offers it nothing to change', async () => {
    inSupportSession('READ_ONLY');

    const json = await body(await list());

    expect(json.data.readOnly).toBe(true);
  });

  it('refuses a MEMBER', async () => {
    actingAs(DEFAULT_ORG_ROLE);
    expect((await list()).status).toBe(403);
  });

  it('refuses an admin of another org naming this one', async () => {
    actingAs(ORG_OWNER_ROLE, ELSEWHERE);
    expect((await list()).status).toBe(403);
  });

  it('refuses a platform admin who is not acting in the org', async () => {
    // Acting in the install org, as its OWNER: the default policy admits a
    // platform admin to every org, and the route keeps them to their own.
    mockGetSession.mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    mockDb.orgMembership.findUnique.mockResolvedValue({
      role: ORG_OWNER_ROLE,
      org: { status: 'ACTIVE' },
    });

    const res = await list();

    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toMatch(/Switch to this organisation/);
  });

  it('refuses the install org: it runs on the platform’s own keys', async () => {
    mockGetSession.mockResolvedValue(session('ADMIN', INSTALL_ORG_ID));
    mockDb.orgMembership.findUnique.mockResolvedValue({
      role: ORG_OWNER_ROLE,
      org: { status: 'ACTIVE' },
    });

    const res = await list(INSTALL_ORG_ID);

    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toEqual({ reason: 'install_org' });
  });
});

describe('PUT — save and replace', () => {
  it('tests the submitted key, stores it sealed for this org and row, and audits the save with the hint only', async () => {
    actingAs(ORG_ADMIN_ROLE);

    const res = await save(ANTHROPIC.id);
    const text = await res.clone().text();
    const json = await body(res);

    expect(res.status).toBe(201);
    expect(json.data).toEqual({
      providerConfigId: ANTHROPIC.id,
      replaced: false,
      key: { hint: 'wxyz', version: 1, savedAt: expect.any(String) },
    });
    expect(mockTestProviderKey).toHaveBeenCalledTimes(1);
    expect(mockTestProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: ANTHROPIC.id }),
      KEY
    );
    const row = orgKeyTable.get(ORG, ANTHROPIC.id)!;
    expect(row.savedById).toBe(USER_ID);
    expect(await openSecret(row.sealedKey, orgProviderKeyPurpose(ORG, ANTHROPIC.id))).toBe(KEY);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        action: 'org_provider_key.save',
        entityType: 'org_provider_key',
        entityId: row.id,
        entityName: 'Anthropic',
        metadata: {
          orgId: ORG,
          provider: 'anthropic',
          hint: 'wxyz',
          version: 1,
          result: 'passed',
        },
      })
    );
    expectNoKeyAnywhere(text, KEY, row.sealedKey);
  });

  it('replaces a saved key: the version rises, the new key is stored, and it is audited as a rotation', async () => {
    actingAs(ORG_OWNER_ROLE);
    await save(ANTHROPIC.id, KEY);
    mockAudit.mockClear();

    const res = await save(ANTHROPIC.id, NEW_KEY);
    const text = await res.clone().text();
    const json = await body(res);

    expect(res.status).toBe(200);
    expect(json.data).toEqual(
      expect.objectContaining({
        replaced: true,
        key: expect.objectContaining({ hint: 'abcd', version: 2 }),
      })
    );
    const row = orgKeyTable.get(ORG, ANTHROPIC.id)!;
    expect(await openSecret(row.sealedKey, orgProviderKeyPurpose(ORG, ANTHROPIC.id))).toBe(NEW_KEY);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_provider_key.rotate',
        metadata: expect.objectContaining({ hint: 'abcd', version: 2 }),
      })
    );
    expectNoKeyAnywhere(text, KEY, NEW_KEY);
  });

  it('does not store a key that fails its test, says so without the vendor’s message, and audits the failed test', async () => {
    actingAs(ORG_ADMIN_ROLE);
    // Vendors do repeat a rejected key back.
    mockTestProviderKey.mockResolvedValue({
      ok: false,
      models: [],
      error: `401 invalid x-api-key: ${KEY}`,
    });

    const res = await save(ANTHROPIC.id);
    const text = await res.clone().text();
    const json = await body(res);

    expect(res.status).toBe(422);
    expect(json.error.code).toBe('KEY_TEST_FAILED');
    expect(json.error.message).toMatch(/Anthropic did not accept this key.*not been saved/);
    expect(orgKeyTable.rows.size).toBe(0);
    expect(orgKeyTable.delegate.upsert).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_provider_key.test',
        metadata: expect.objectContaining({ result: 'test_failed', stored: false, hint: 'wxyz' }),
      })
    );
    // The log keeps the vendor's reason for an operator, with the key cut out.
    expect(mockLog.warn).toHaveBeenCalledWith(
      'An org’s AI key failed its test call',
      expect.objectContaining({ detail: '401 invalid x-api-key: [key]', during: 'save' })
    );
    expectNoKeyAnywhere(text, KEY);
  });

  it('treats a client that cannot be built as a failed test, and stores nothing', async () => {
    actingAs(ORG_ADMIN_ROLE);
    mockTestProviderKey.mockRejectedValue(new Error('unsafe baseUrl'));

    const res = await save(OPENAI.id);

    expect(res.status).toBe(422);
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses a provider the org is not approved for, before any vendor call', async () => {
    actingAs(ORG_ADMIN_ROLE);
    approvals.slugs = new Set(['anthropic']);

    const res = await save(OPENAI.id);

    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toEqual({ reason: 'not_approved' });
    expect(mockTestProviderKey).not.toHaveBeenCalled();
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses while own keys are switched off, since the key would refuse every call', async () => {
    actingAs(ORG_ADMIN_ROLE);
    switchState.on = false;

    const res = await save(ANTHROPIC.id);

    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toEqual({ reason: 'switched_off' });
    expect(mockTestProviderKey).not.toHaveBeenCalled();
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses a local provider, which takes no key', async () => {
    actingAs(ORG_ADMIN_ROLE);
    approvals.slugs = new Set(['ollama-local']);

    const res = await save(OLLAMA.id);

    expect(res.status).toBe(404);
    expect(mockTestProviderKey).not.toHaveBeenCalled();
  });

  it('refuses a support session, whatever its grant level, and stores nothing', async () => {
    inSupportSession('ADMIN');

    const res = await save(ANTHROPIC.id);

    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toMatch(/Support staff cannot save or replace/);
    expect(mockTestProviderKey).not.toHaveBeenCalled();
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses a support session replacing a saved key', async () => {
    await storedKey(ANTHROPIC);
    inSupportSession('ADMIN');

    expect((await save(ANTHROPIC.id, NEW_KEY)).status).toBe(403);
    expect(orgKeyTable.get(ORG, ANTHROPIC.id)!.version).toBe(1);
  });

  it('refuses a MEMBER, and an admin of another org', async () => {
    actingAs(DEFAULT_ORG_ROLE);
    expect((await save(ANTHROPIC.id)).status).toBe(403);
    actingAs(ORG_OWNER_ROLE, ELSEWHERE);
    expect((await save(ANTHROPIC.id)).status).toBe(403);
    expect(mockTestProviderKey).not.toHaveBeenCalled();
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('trims a pasted key’s surrounding whitespace, and refuses one with a line break inside', async () => {
    actingAs(ORG_ADMIN_ROLE);

    expect((await save(ANTHROPIC.id, `  ${KEY}\n`)).status).toBe(201);
    expect(mockTestProviderKey).toHaveBeenCalledWith(expect.anything(), KEY);

    const res = await save(OPENAI.id, 'sk-half\nsk-other-half');
    expect(res.status).toBe(400);
    // A zero-width space from a rich-text paste is a field error too, never a
    // vendor call that fails as if the vendor refused the key.
    expect((await save(OPENAI.id, 'sk-pasted\u200b-key-0000000000')).status).toBe(400);
    expect(mockTestProviderKey).toHaveBeenCalledTimes(1);
    expect(orgKeyTable.get(ORG, OPENAI.id)).toBeUndefined();
  });

  it('caps saves at 10 a minute per org, before the vendor call, and never lets testing use up saving', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(OPENAI);
    // Ten tests (support's, or another admin's) first: the org can still save.
    for (let i = 0; i < 10; i += 1) expect((await test(OPENAI.id)).status).toBe(200);
    expect((await test(OPENAI.id)).status).toBe(429);
    for (let i = 0; i < 10; i += 1) expect((await save(ANTHROPIC.id)).status).toBeLessThan(300);
    mockTestProviderKey.mockClear();

    expect((await save(ANTHROPIC.id)).status).toBe(429);
    expect(mockTestProviderKey).not.toHaveBeenCalled();
  });

  it('cuts a key a vendor echoes JSON-escaped out of the log line', async () => {
    actingAs(ORG_ADMIN_ROLE);
    const quoted = 'sk-quoted"key\\with-escapes-000000';
    mockTestProviderKey.mockResolvedValue({
      ok: false,
      models: [],
      error: JSON.stringify({ error: `bad key ${quoted}` }),
    });

    expect((await save(ANTHROPIC.id, quoted)).status).toBe(422);

    const logged = everythingLoggedOrAudited();
    expect(logged).not.toContain(JSON.stringify(quoted).slice(1, -1));
    expect(mockLog.warn).toHaveBeenCalledWith(
      'An org’s AI key failed its test call',
      expect.objectContaining({ detail: expect.stringContaining('[key]') })
    );
  });

  it('answers a database failure generically, and logs the error’s name, never its message', async () => {
    actingAs(ORG_ADMIN_ROLE);
    orgKeyTable.delegate.upsert.mockRejectedValueOnce(
      Object.assign(new Error('Invalid `upsert()` invocation: { sealedKey: "v2.one.SEALED" }'), {
        code: 'P2028',
      })
    );

    const res = await save(ANTHROPIC.id);
    const text = await res.clone().text();

    expect(res.status).toBe(500);
    expect((await body(res)).error.message).toBe('The key could not be saved. Try again.');
    expect(mockLog.error).toHaveBeenCalledWith(
      'Could not save an org’s AI key',
      undefined,
      expect.objectContaining({ error: 'Error P2028' })
    );
    expect(text).not.toContain('SEALED');
    expect(everythingLoggedOrAudited()).not.toContain('SEALED');
  });
});

describe('without a master key', () => {
  function noKeyring(): void {
    delete envOverrides.SEALED_SECRET_KEYS;
    delete envOverrides.SEALED_SECRET_ACTIVE_KEY;
  }

  it('refuses a save before any vendor call, saying platform staff must configure it', async () => {
    actingAs(ORG_ADMIN_ROLE);
    noKeyring();

    const res = await save(ANTHROPIC.id);

    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toEqual({ reason: 'master_key_missing' });
    expect(mockTestProviderKey).not.toHaveBeenCalled();
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses a test of a saved key the same way', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC);
    noKeyring();

    const res = await test(ANTHROPIC.id);

    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toEqual({ reason: 'master_key_missing' });
    expect(mockTestProviderKey).not.toHaveBeenCalled();
  });

  it('lists a saved key as will not open', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC);
    noKeyring();

    expect((await body(await list())).data.providers[0].key.state).toBe('will_not_open');
  });
});

describe('a failed read of the key store', () => {
  it('answers generically on the list, and logs the error’s name only', async () => {
    actingAs(ORG_ADMIN_ROLE);
    orgKeyTable.delegate.findMany.mockRejectedValueOnce(
      new Error('connection reset; sealedKey=SEALED')
    );

    const res = await list();

    expect(res.status).toBe(500);
    expect((await body(res)).error.message).toBe('The key could not be read. Try again.');
    expect(everythingLoggedOrAudited()).not.toContain('SEALED');
  });

  it('answers generically on a remove', async () => {
    actingAs(ORG_ADMIN_ROLE);
    orgKeyTable.delegate.findUnique.mockRejectedValueOnce(new Error('timeout'));

    const res = await remove(ANTHROPIC.id);

    expect(res.status).toBe(500);
    expect((await body(res)).error.message).toBe('The key could not be removed. Try again.');
  });
});

describe('POST …/test — test a saved key', () => {
  it('tests the saved key with one vendor call and audits a pass', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC);

    const res = await test(ANTHROPIC.id);
    const text = await res.clone().text();

    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ providerConfigId: ANTHROPIC.id, ok: true });
    expect(mockTestProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({ id: ANTHROPIC.id }),
      KEY
    );
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_provider_key.test',
        entityId: 'key-anthropic',
        metadata: expect.objectContaining({ hint: 'wxyz', result: 'passed' }),
      })
    );
    expectNoKeyAnywhere(text, KEY);
  });

  it('reports a key the vendor refuses as a failed test, without the vendor’s message', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC);
    mockTestProviderKey.mockResolvedValue({ ok: false, models: [], error: `bad key ${KEY}` });

    const res = await test(ANTHROPIC.id);
    const text = await res.clone().text();

    expect((await body(res)).data).toEqual({
      providerConfigId: ANTHROPIC.id,
      ok: false,
      reason: 'test_failed',
    });
    expectNoKeyAnywhere(text, KEY);
  });

  it('reports a key that will not open, and makes no vendor call', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC, KEY, orgProviderKeyPurpose(ELSEWHERE, ANTHROPIC.id));

    const json = await body(await test(ANTHROPIC.id));

    expect(json.data).toEqual({
      providerConfigId: ANTHROPIC.id,
      ok: false,
      reason: 'will_not_open',
    });
    expect(mockTestProviderKey).not.toHaveBeenCalled();
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ result: 'will_not_open' }) })
    );
  });

  it('answers 404 when no key is saved', async () => {
    actingAs(ORG_ADMIN_ROLE);
    expect((await test(ANTHROPIC.id)).status).toBe(404);
  });

  it('runs while own keys are switched off, so a key can be checked before they are turned back on', async () => {
    actingAs(ORG_ADMIN_ROLE);
    switchState.on = false;
    await storedKey(ANTHROPIC);

    expect((await body(await test(ANTHROPIC.id))).data.ok).toBe(true);
  });

  it('lets a support session test, and a read-only one not', async () => {
    await storedKey(ANTHROPIC);
    inSupportSession('ADMIN');
    expect((await test(ANTHROPIC.id)).status).toBe(200);

    inSupportSession('READ_ONLY');
    expect((await test(ANTHROPIC.id)).status).toBe(403);
  });

  it('refuses a MEMBER', async () => {
    actingAs(DEFAULT_ORG_ROLE);
    await storedKey(ANTHROPIC);
    expect((await test(ANTHROPIC.id)).status).toBe(403);
    expect(mockTestProviderKey).not.toHaveBeenCalled();
  });
});

describe('DELETE — remove', () => {
  it('removes the key and audits it with the hint', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC);

    const res = await remove(ANTHROPIC.id);

    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ providerConfigId: ANTHROPIC.id, removed: true });
    expect(orgKeyTable.rows.size).toBe(0);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'org_provider_key.remove',
        entityId: 'key-anthropic',
        entityName: 'Anthropic',
        metadata: { orgId: ORG, provider: 'anthropic', hint: 'wxyz', version: 1 },
      })
    );
    expectNoKeyAnywhere('', KEY);
  });

  it('leaves a key replaced while it was being removed, and says so', async () => {
    actingAs(ORG_ADMIN_ROLE);
    await storedKey(ANTHROPIC);
    // Another admin replaces the key between this removal's read and its delete.
    const read = orgKeyTable.delegate.findUnique.getMockImplementation()!;
    orgKeyTable.delegate.findUnique.mockImplementationOnce(async (args) => {
      const row = await read(args);
      orgKeyTable.get(ORG, ANTHROPIC.id)!.version = 2;
      return row;
    });

    const res = await remove(ANTHROPIC.id);

    expect(res.status).toBe(409);
    expect((await body(res)).error.details).toEqual({ reason: 'key_changed' });
    expect(orgKeyTable.get(ORG, ANTHROPIC.id)?.version).toBe(2);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('answers 404 when there is no key to remove', async () => {
    actingAs(ORG_ADMIN_ROLE);
    expect((await remove(ANTHROPIC.id)).status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('lets a support session remove a key', async () => {
    await storedKey(ANTHROPIC);
    inSupportSession('ADMIN');

    expect((await remove(ANTHROPIC.id)).status).toBe(200);
    expect(orgKeyTable.rows.size).toBe(0);
  });

  it('refuses a MEMBER, and an admin of another org', async () => {
    await storedKey(ANTHROPIC);
    actingAs(DEFAULT_ORG_ROLE);
    expect((await remove(ANTHROPIC.id)).status).toBe(403);
    actingAs(ORG_OWNER_ROLE, ELSEWHERE);
    expect((await remove(ANTHROPIC.id)).status).toBe(403);
    expect(orgKeyTable.rows.size).toBe(1);
  });
});

describe('the policy decides who, as its own resource kind', () => {
  /** The default policy, except as `rule` says for the keys' resource kind. */
  function policyForKeys(rule: (orgRole: string | null | undefined) => boolean) {
    registerAuthorizationPolicy({
      ...DEFAULT_AUTHORIZATION_POLICY,
      canRead: async (viewer, target, scope) =>
        target.kind === 'unattributed' &&
        target.resource.kind === 'org.providerKeys' &&
        target.resource.orgId === viewer.orgId
          ? rule(viewer.orgRole)
          : DEFAULT_AUTHORIZATION_POLICY.canRead(viewer, target, scope),
    });
  }

  it('lets a MEMBER in when a policy widens the action to them', async () => {
    policyForKeys(() => true);
    actingAs(DEFAULT_ORG_ROLE);

    expect((await list()).status).toBe(200);
    expect((await save(ANTHROPIC.id)).status).toBe(201);
  });

  it('keeps an ADMIN out when a policy narrows the action to OWNERs', async () => {
    policyForKeys((orgRole) => orgRole === ORG_OWNER_ROLE);

    actingAs(ORG_ADMIN_ROLE);
    expect((await list()).status).toBe(403);
    expect((await save(ANTHROPIC.id)).status).toBe(403);

    actingAs(ORG_OWNER_ROLE);
    expect((await save(ANTHROPIC.id)).status).toBe(201);
  });
});
