/**
 * Tests: a platform admin in the install org force-fails a customer org's run
 * and clears its conversations by naming it (t-1083)
 *
 * POST /api/v1/admin/orchestration/executions/:id/force-fail?orgId=
 * POST /api/v1/admin/orchestration/conversations/clear?orgId=
 *
 * Since #1177 a platform admin inside a customer org is presented as their org
 * role, so these platform-tier routes refuse them there: from the install org
 * they reached only the install org's rows. `?orgId=` names the customer org
 * instead. The real `withAdminAuth` runs at `multi` and enters the org the
 * session names; every data call records the tenant context it ran in, so a
 * call that ran in the caller's org rather than the named one fails here.
 *
 * @see lib/tenancy/target-org.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));
vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));
vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/auth/api-keys', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/api-keys')>()),
  resolveApiKey: vi.fn().mockResolvedValue(null),
}));

/** The org each data call ran in, in call order. */
const ranIn = vi.hoisted(() => [] as Array<{ call: string; orgId: string | null | undefined }>);
const contextOf = vi.hoisted(() => ({ read: (): string | null | undefined => undefined }));
const recording = vi.hoisted(() => <T>(call: string, answer: () => T) => () => {
  ranIn.push({ call, orgId: contextOf.read() });
  return Promise.resolve(answer());
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    orgMembership: { findUnique: vi.fn() },
    org: { findUnique: vi.fn() },
    aiWorkflowExecution: { findUnique: vi.fn(), updateMany: vi.fn() },
    aiWorkflowRunningStep: { deleteMany: vi.fn() },
    aiConversation: { deleteMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/orchestration/engine/lease', () => ({ recordForceFailEvent: vi.fn() }));
vi.mock('@/lib/orchestration/hooks/registry', () => ({
  emitHookEvent: vi.fn((event: string) => {
    ranIn.push({ call: `hook ${event}`, orgId: contextOf.read() });
  }),
}));

// ─── Imports ────────────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { getTenantContext } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { mockAdminUser } from '@/tests/helpers/auth';
import { POST as forceFail } from '@/app/api/v1/admin/orchestration/executions/[id]/force-fail/route';
import { POST as clearConversations } from '@/app/api/v1/admin/orchestration/conversations/clear/route';

contextOf.read = () => getTenantContext()?.orgId;

// ─── Fixtures ───────────────────────────────────────────────────────────

const CUSTOMER_ORG = 'cmorg00000000000000000orga';
const MISSING_ORG = 'cmorg00000000000000000gone';
const EXEC_ID = 'cmjbv4i3x00003wsloputgwu9';
const WORKFLOW_ID = 'cmjbv4i3x00003wsloputgwf1';

/** A platform admin whose session is in `activeOrgId`, where they are an org ADMIN. */
function signedInTo(activeOrgId: string) {
  const session = mockAdminUser();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    ...session,
    session: { ...session.session, activeOrgId },
  });
}

function forceFailRequest(orgId?: string): NextRequest {
  const query = orgId ? `?orgId=${orgId}` : '';
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/executions/${EXEC_ID}/force-fail${query}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
  );
}

function clearRequest(orgId?: string): NextRequest {
  const query = orgId ? `?orgId=${orgId}` : '';
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/conversations/clear${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allUsers: true, olderThan: '2026-01-01T00:00:00.000Z' }),
    }
  );
}

const params = { params: Promise.resolve({ id: EXEC_ID }) };

/** The data calls that touched the run or the conversations, with the org each ran in. */
function dataCalls() {
  return ranIn.filter((r) => !r.call.startsWith('orgMembership') && !r.call.startsWith('org.'));
}

beforeEach(() => {
  vi.clearAllMocks();
  ranIn.length = 0;
  mockEnv.TENANCY_MODE = 'multi';
  vi.mocked(prisma.orgMembership.findUnique).mockImplementation(
    recording('orgMembership.findUnique', () => ({
      role: 'ADMIN',
      org: { status: 'ACTIVE' },
    })) as never
  );
  vi.mocked(prisma.org.findUnique).mockImplementation(((args: { where: { id: string } }) => {
    ranIn.push({ call: 'org.findUnique', orgId: contextOf.read() });
    return Promise.resolve(args.where.id === MISSING_ORG ? null : { status: 'ACTIVE' });
  }) as never);
  vi.mocked(prisma.aiWorkflowExecution.findUnique).mockImplementation(
    recording('execution.findUnique', () => ({
      id: EXEC_ID,
      // System-owned: a scheduled run, the case this route exists for.
      userId: null,
      workflowId: WORKFLOW_ID,
      status: 'running',
      leaseToken: 'lease-1',
      workflow: { name: 'Nightly sync' },
    })) as never
  );
  vi.mocked(prisma.aiWorkflowExecution.updateMany).mockImplementation(
    recording('execution.updateMany', () => ({ count: 1 })) as never
  );
  vi.mocked(prisma.aiWorkflowRunningStep.deleteMany).mockImplementation(
    recording('runningStep.deleteMany', () => ({ count: 0 })) as never
  );
  vi.mocked(prisma.$transaction).mockImplementation(((fn: (tx: typeof prisma) => unknown) =>
    fn(prisma)) as never);
  vi.mocked(prisma.aiConversation.deleteMany).mockImplementation(
    recording('conversation.deleteMany', () => ({ count: 3 })) as never
  );
});

describe('from the install org, naming a customer org', () => {
  beforeEach(() => signedInTo(INSTALL_ORG_ID));

  it('force-fails the customer org’s run inside that org, and audits it there', async () => {
    const response = await forceFail(forceFailRequest(CUSTOMER_ORG), params);

    expect(response.status).toBe(200);
    expect(dataCalls()).toEqual([
      { call: 'execution.findUnique', orgId: CUSTOMER_ORG },
      { call: 'execution.updateMany', orgId: CUSTOMER_ORG },
      { call: 'runningStep.deleteMany', orgId: CUSTOMER_ORG },
      // The customer's own webhooks are told, not the install org's.
      { call: 'hook workflow.failed', orgId: CUSTOMER_ORG },
      { call: 'hook execution.force_failed', orgId: CUSTOMER_ORG },
    ]);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'execution.force_failed', actingOrgId: CUSTOMER_ORG })
    );
  });

  it('clears the customer org’s conversations inside that org, and audits it there', async () => {
    const response = await clearConversations(clearRequest(CUSTOMER_ORG));

    expect(response.status).toBe(200);
    expect(dataCalls()).toEqual([{ call: 'conversation.deleteMany', orgId: CUSTOMER_ORG }]);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conversation.bulk_clear', actingOrgId: CUSTOMER_ORG })
    );
  });

  it('answers 404 for an org that does not exist, and touches nothing', async () => {
    expect((await forceFail(forceFailRequest(MISSING_ORG), params)).status).toBe(404);
    expect((await clearConversations(clearRequest(MISSING_ORG))).status).toBe(404);
    expect(dataCalls()).toEqual([]);
    expect(logAdminAction).not.toHaveBeenCalled();
  });

  it('acts on the install org itself when no org is named, as before', async () => {
    expect((await clearConversations(clearRequest())).status).toBe(200);
    expect(dataCalls()).toEqual([{ call: 'conversation.deleteMany', orgId: INSTALL_ORG_ID }]);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ actingOrgId: INSTALL_ORG_ID })
    );
  });
});

describe('from inside the customer org', () => {
  beforeEach(() => signedInTo(CUSTOMER_ORG));

  it('is still refused: a platform admin there is presented as their org role (#1177)', async () => {
    expect((await forceFail(forceFailRequest(CUSTOMER_ORG), params)).status).toBe(403);
    expect((await forceFail(forceFailRequest(), params)).status).toBe(403);
    expect((await clearConversations(clearRequest(CUSTOMER_ORG))).status).toBe(403);
    expect((await clearConversations(clearRequest())).status).toBe(403);
    expect(dataCalls()).toEqual([]);
    expect(logAdminAction).not.toHaveBeenCalled();
  });
});
