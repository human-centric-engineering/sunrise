/**
 * Tests: an audit row made inside a support session names the grant and the
 * org it was made in (§121 t-825)
 *
 * Drives a real org-tier admin handler — the invite-token revoke — through the
 * real guards, entry and audit logger, with Prisma mocked at the client. The
 * handler is not edited and knows nothing about support: the stamp comes from
 * the tenant context the guard entered. The same handler, called by the org's
 * own ADMIN, writes a row with no stamp.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ORG_ADMIN_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const db = vi.hoisted(() => ({
  orgMembership: { findUnique: vi.fn() },
  orgSupportGrant: { findFirst: vi.fn() },
  org: { findMany: vi.fn() },
  aiAgentInviteToken: { findFirst: vi.fn(), update: vi.fn() },
  aiAdminAuditLog: { create: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('@/lib/auth/api-keys', () => ({
  resolveApiKey: vi.fn().mockResolvedValue(null),
  hasScope: (scopes: string[], required: string) =>
    scopes.includes(required) || scopes.includes('admin'),
  listValidApiKeyScopes: vi.fn(() => ['chat', 'admin']),
}));
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { DELETE } from '@/app/api/v1/admin/orchestration/agents/[id]/invite-tokens/[tokenId]/route';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { withAdminAuth } from '@/lib/auth/guards';
import { runAsOrg, runAsSystem } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const CUSTOMER = 'cmorg00000000000customer1';
const GRANT_ID = 'cmgrant000000000000grant1';
const AGENT_ID = 'cmagent00000000000agent01';
const TOKEN_ID = 'cmtoken00000000000token01';
const EXPIRES = new Date(Date.now() + 3_600_000);

function session(role: 'USER' | 'ADMIN') {
  return {
    session: {
      id: 'session_1',
      userId: 'user_1',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      activeOrgId: CUSTOMER,
    },
    user: {
      id: 'user_1',
      name: 'Support Person',
      email: 'support@vendor.example',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function revoke() {
  const url = `http://localhost:3000/api/v1/admin/orchestration/agents/${AGENT_ID}/invite-tokens/${TOKEN_ID}`;
  return DELETE(new NextRequest(url, { method: 'DELETE' }), {
    params: Promise.resolve({ id: AGENT_ID, tokenId: TOKEN_ID }),
  });
}

/** The `data` of the one audit row the request wrote. */
function writtenRow(): Record<string, unknown> {
  expect(db.aiAdminAuditLog.create).toHaveBeenCalledTimes(1);
  return db.aiAdminAuditLog.create.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  vi.mocked(headers).mockResolvedValue(new Headers());
  db.orgMembership.findUnique.mockResolvedValue(null);
  db.orgSupportGrant.findFirst.mockResolvedValue(null);
  db.aiAgentInviteToken.findFirst.mockResolvedValue({
    id: TOKEN_ID,
    agentId: AGENT_ID,
    label: 'Partner',
    revokedAt: null,
  });
  db.aiAgentInviteToken.update.mockResolvedValue({});
  db.aiAdminAuditLog.create.mockResolvedValue({});
});

describe('a real admin handler inside a support session', () => {
  it('writes its audit row with the grant and the org, naming the individual', async () => {
    // A platform admin, not a member, admitted under the org's open grant.
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN'));
    db.orgSupportGrant.findFirst.mockResolvedValue({
      id: GRANT_ID,
      level: 'ADMIN',
      expiresAt: EXPIRES,
    });

    const res = await revoke();

    expect(res.status).toBe(200);
    expect(db.aiAgentInviteToken.update).toHaveBeenCalledTimes(1);
    expect(writtenRow()).toMatchObject({
      userId: 'user_1',
      action: 'agent.invite_token_revoke',
      supportGrantId: GRANT_ID,
      supportOrgId: CUSTOMER,
      actingOrgId: CUSTOMER,
    });
  });

  it('writes no stamp when the org’s own ADMIN makes the same change', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('USER'));
    db.orgMembership.findUnique.mockResolvedValue({
      role: ORG_ADMIN_ROLE,
      org: { status: 'ACTIVE' },
    });

    const res = await revoke();

    expect(res.status).toBe(200);
    // The same handler wrote the same row — only without a support session.
    expect(writtenRow()).toMatchObject({
      userId: 'user_1',
      action: 'agent.invite_token_revoke',
      supportGrantId: null,
      supportOrgId: null,
      // …but it still names the org it was made in (t-1005).
      actingOrgId: CUSTOMER,
    });
    expect(db.orgSupportGrant.findFirst).not.toHaveBeenCalled();
  });
});

describe('logAdminAction’s support stamp', () => {
  const entry = { userId: 'user_1', action: 'agent.update', entityType: 'agent' };
  const support = { grantId: GRANT_ID, level: 'ADMIN' as const, expiresAt: EXPIRES };

  it('is read when the action is logged, so a write settling after the scope still carries it', async () => {
    let settle: (v: unknown) => void = () => {};
    db.aiAdminAuditLog.create.mockReturnValue(new Promise((r) => (settle = r)));

    await runAsOrg(CUSTOMER, async () => logAdminAction(entry), { source: 'support', support });
    settle({});

    expect(writtenRow()).toMatchObject({ supportGrantId: GRANT_ID, supportOrgId: CUSTOMER });
  });

  it('is absent outside any tenant context', () => {
    logAdminAction(entry);
    expect(writtenRow()).toMatchObject({ supportGrantId: null, supportOrgId: null });
  });

  it('is absent in an org context that is not a support entry', async () => {
    await runAsOrg(CUSTOMER, async () => logAdminAction(entry), { source: 'session' });
    expect(writtenRow()).toMatchObject({ supportGrantId: null, supportOrgId: null });
  });

  it('takes an explicit stamp from a caller acting on a session from outside it', () => {
    logAdminAction({ ...entry, support: { grantId: GRANT_ID, orgId: CUSTOMER } });
    expect(writtenRow()).toMatchObject({ supportGrantId: GRANT_ID, supportOrgId: CUSTOMER });
  });
});

describe('logAdminAction’s acting org (t-1005)', () => {
  const entry = { userId: 'user_1', action: 'agent.update', entityType: 'agent' };

  it('names the org of an ordinary org context', async () => {
    await runAsOrg(CUSTOMER, async () => logAdminAction(entry), { source: 'session' });
    expect(writtenRow()).toMatchObject({ actingOrgId: CUSTOMER, supportOrgId: null });
  });

  it('is read when the action is logged, so a write settling after the scope still carries it', async () => {
    let settle: (v: unknown) => void = () => {};
    db.aiAdminAuditLog.create.mockReturnValue(new Promise((r) => (settle = r)));

    await runAsOrg(CUSTOMER, async () => logAdminAction(entry), { source: 'session' });
    settle({});

    expect(writtenRow()).toMatchObject({ actingOrgId: CUSTOMER });
  });

  it('names no org in a system scope', async () => {
    await runAsSystem('test: a system-scope write', async () => logAdminAction(entry));
    expect(writtenRow()).toMatchObject({ actingOrgId: null });
  });

  it('names the org an explicit support stamp entered, not the caller’s own org', async () => {
    // The switch route's `support.enter`: logged from the support person's own
    // org, about the org they are entering.
    await runAsOrg(
      INSTALL_ORG_ID,
      async () => logAdminAction({ ...entry, support: { grantId: GRANT_ID, orgId: CUSTOMER } }),
      { source: 'session' }
    );
    expect(writtenRow()).toMatchObject({
      actingOrgId: CUSTOMER,
      supportGrantId: GRANT_ID,
      supportOrgId: CUSTOMER,
    });
  });

  it('at TENANCY_MODE=single names the install org and writes the row otherwise unchanged', async () => {
    mockEnv.TENANCY_MODE = 'single';
    await runAsOrg(INSTALL_ORG_ID, async () => logAdminAction(entry), { source: 'session' });
    expect(writtenRow()).toEqual({
      userId: 'user_1',
      action: 'agent.update',
      entityType: 'agent',
      entityId: null,
      entityName: null,
      changes: expect.anything(),
      metadata: expect.anything(),
      clientIp: null,
      supportGrantId: null,
      supportOrgId: null,
      actingOrgId: INSTALL_ORG_ID,
    });
  });
});

describe('logAdminAction’s acting org: the org whose data changed (t-1005 review)', () => {
  const entry = { userId: 'user_1', action: 'org.quotas.update', entityType: 'org' };

  it('takes an explicit org over the context, for a route acting on an org from outside it', async () => {
    await runAsOrg(
      INSTALL_ORG_ID,
      async () => logAdminAction({ ...entry, actingOrgId: CUSTOMER }),
      {
        source: 'session',
      }
    );
    expect(writtenRow()).toMatchObject({ actingOrgId: CUSTOMER, supportOrgId: null });
  });

  it('takes an explicit org with no context at all: an admin API key', () => {
    logAdminAction({ ...entry, actingOrgId: CUSTOMER });
    expect(writtenRow()).toMatchObject({ actingOrgId: CUSTOMER });
  });

  it('takes an explicit null as “no org’s history”, even inside an org', async () => {
    await runAsOrg(CUSTOMER, async () => logAdminAction({ ...entry, actingOrgId: null }), {
      source: 'session',
    });
    expect(writtenRow()).toMatchObject({ actingOrgId: null });
  });

  it.each(['single', 'multi'])(
    'with no context at all names the install org at %s: an unbound admin API key acts as it',
    (mode) => {
      mockEnv.TENANCY_MODE = mode;
      logAdminAction(entry);
      expect(writtenRow()).toMatchObject({ actingOrgId: INSTALL_ORG_ID });
    }
  );
});

describe('a real admin route files its row under the org it changed (t-1005 review)', () => {
  // A platform admin who is also an ADMIN member of the customer org, acting
  // in it. The same body behind a platform-tier route and an org-tier one: a
  // platform-tier route (clearing conversations, force-failing a run) changes
  // the entered org's own rows, so both are that org's history.
  const body = () => {
    logAdminAction({ userId: 'user_1', action: 'execution.force_failed', entityType: 'execution' });
    return new Response(null, { status: 204 });
  };
  const platformRoute = withAdminAuth(async () => body());
  const orgRoute = withAdminAuth(async () => body(), { tier: 'org' });
  const call = (route: typeof platformRoute) =>
    route(new NextRequest('http://localhost:3000/api/v1/admin/x', { method: 'POST' }));

  beforeEach(() => {
    vi.mocked(auth.api.getSession).mockResolvedValue(session('ADMIN'));
    db.orgMembership.findUnique.mockResolvedValue({
      role: ORG_ADMIN_ROLE,
      org: { status: 'ACTIVE' },
    });
  });

  it('on a platform-tier route', async () => {
    expect((await call(platformRoute)).status).toBe(204);
    expect(writtenRow()).toMatchObject({ actingOrgId: CUSTOMER });
  });

  it('on an org-tier route', async () => {
    expect((await call(orgRoute)).status).toBe(204);
    expect(writtenRow()).toMatchObject({ actingOrgId: CUSTOMER });
  });
});
