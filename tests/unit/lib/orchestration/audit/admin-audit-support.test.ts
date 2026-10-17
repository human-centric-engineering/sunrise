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
import { runAsOrg } from '@/lib/tenancy/context';

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
