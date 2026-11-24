/**
 * Integration: shared-settings writes refuse a customer org at multi (§107 t-751)
 *
 * One write route per family, through the real `withAdminAuth`: a caller a
 * policy admits from a customer org is refused with the install-org message
 * and nothing is written (a platform admin there is refused before that, as
 * their org role — t-1032); from the install org, and at `single`, the guard
 * lets the same request through to the handler. The guard's own arms (API
 * key, the ordinary refusal first) are in `guards-tenancy.test.ts`; that
 * every writing route declares the option is the whole-tree test's job
 * (`tests/unit/scripts/ci/shared-settings-writes.test.ts`).
 *
 * Prisma is a stub that answers every call with nothing, so a handler that
 * does run gets an empty world; the controls assert only that the guard did
 * not stop it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';

/** Every Prisma model method, created on first use and kept, so a test can ask what was called. */
const prismaStub = vi.hoisted(() => {
  const models = new Map<string, Record<string, ReturnType<typeof vi.fn>>>();
  const model = (name: string) => {
    let methods = models.get(name);
    if (!methods) {
      const created: Record<string, ReturnType<typeof vi.fn>> = {};
      methods = new Proxy(created, {
        get: (target, method: string) => (target[method] ??= vi.fn(async () => null)),
      });
      models.set(name, methods);
    }
    return methods;
  };
  const client: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === '$transaction') {
          return vi.fn(async (arg: unknown) =>
            typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(client) : []
          );
        }
        if (name.startsWith('$')) return vi.fn(async () => null);
        if (name === 'then') return undefined;
        return model(name);
      },
    }
  );
  return { client, models };
});
vi.mock('@/lib/db/client', () => ({ prisma: prismaStub.client }));
vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));

import { auth } from '@/lib/auth/config';
import { env } from '@/lib/env';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import {
  SHARED_SETTINGS_REFUSAL,
  SHARED_SETTINGS_REFUSAL_CODE,
} from '@/lib/tenancy/shared-settings';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { __resetAuthorizationPolicyForTests } from '@/lib/auth/authorization';
import { registerForkAdmittingOrgOwners } from '@/tests/helpers/fork-admits-org-owners';

import * as providers from '@/app/api/v1/admin/orchestration/providers/route';
import * as providerModel from '@/app/api/v1/admin/orchestration/provider-models/[id]/route';
import * as capabilities from '@/app/api/v1/admin/orchestration/capabilities/route';
import * as agentProfile from '@/app/api/v1/admin/orchestration/agent-profiles/[id]/route';
import * as knowledgeTags from '@/app/api/v1/admin/orchestration/knowledge/tags/route';
import * as knowledgeSeed from '@/app/api/v1/admin/orchestration/knowledge/seed/route';
import * as mcpTool from '@/app/api/v1/admin/orchestration/mcp/tools/[id]/route';
import * as mcpSettings from '@/app/api/v1/admin/orchestration/mcp/settings/route';
import * as settings from '@/app/api/v1/admin/orchestration/settings/route';
import * as featureFlags from '@/app/api/v1/admin/feature-flags/route';

const CUSTOMER = 'cmorg00000000000customer';
const ID = 'cmjbv4i3x00003wsloputgwul';

type Handler = (
  request: NextRequest,
  context?: { params: Promise<{ id: string }> }
) => Promise<Response>;

const FAMILIES: Array<[family: string, method: string, path: string, handler: Handler]> = [
  ['providers', 'POST', 'orchestration/providers', providers.POST],
  [
    'provider models',
    'PATCH',
    `orchestration/provider-models/${ID}`,
    providerModel.PATCH as Handler,
  ],
  ['capabilities', 'POST', 'orchestration/capabilities', capabilities.POST],
  [
    'agent profiles',
    'DELETE',
    `orchestration/agent-profiles/${ID}`,
    agentProfile.DELETE as Handler,
  ],
  ['knowledge tags', 'POST', 'orchestration/knowledge/tags', knowledgeTags.POST],
  ['knowledge seed', 'POST', 'orchestration/knowledge/seed', knowledgeSeed.POST],
  ['MCP exposure', 'PATCH', `orchestration/mcp/tools/${ID}`, mcpTool.PATCH as Handler],
  ['MCP server config', 'PATCH', 'orchestration/mcp/settings', mcpSettings.PATCH],
  ['orchestration settings', 'PATCH', 'orchestration/settings', settings.PATCH],
  ['feature flags', 'POST', 'feature-flags', featureFlags.POST],
  // Backup import is not here: it no longer declares writesSharedSettings (§109 t-738).
  // It refuses the shared part per request instead; see backup/import.test.ts.
];

const WRITE = /^(create|update|upsert|delete)/;

function writesMade(): string[] {
  return [...prismaStub.models].flatMap(([model, methods]) =>
    Object.entries(methods)
      .filter(([method, fn]) => WRITE.test(method) && fn.mock.calls.length > 0)
      .map(([method]) => `${model}.${method}`)
  );
}

function adminIn(orgId: string) {
  const admin = mockAdminUser();
  // The guard reads `activeOrgId`, which the helper's session leaves out.
  vi.mocked(auth.api.getSession).mockResolvedValue({
    ...admin,
    session: { ...admin.session, activeOrgId: orgId },
  });
  // The guard verifies the switch: the admin is a member of the org named.
  prismaStub.models.clear();
  vi.mocked(
    (prismaStub.client.orgMembership as { findUnique: ReturnType<typeof vi.fn> }).findUnique
  ).mockResolvedValue({ role: ORG_OWNER_ROLE, org: { status: 'ACTIVE' } });
}

/**
 * An OWNER of `orgId` who is not a platform admin, on an install whose fork
 * policy admits org owners to these platform routes. Since t-1032 that is who
 * reaches them from a customer org: a platform admin there is presented as
 * their org role, and the default policy refuses them first.
 */
function forkAdmitsOwnerIn(orgId: string) {
  const owner = mockAuthenticatedUser();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    ...owner,
    session: { ...owner.session, activeOrgId: orgId },
  });
  prismaStub.models.clear();
  vi.mocked(
    (prismaStub.client.orgMembership as { findUnique: ReturnType<typeof vi.fn> }).findUnique
  ).mockResolvedValue({ role: ORG_OWNER_ROLE, org: { status: 'ACTIVE' } });
  registerForkAdmittingOrgOwners();
}

async function send(method: string, path: string, handler: Handler) {
  const request = new NextRequest(`http://localhost:3000/api/v1/admin/${path}`, {
    method,
    body: method === 'DELETE' ? undefined : JSON.stringify({}),
    headers: { 'content-type': 'application/json' },
  });
  const response = await handler(request, { params: Promise.resolve({ id: ID }) });
  const body = (await response.json()) as {
    error?: { message?: string; details?: { reason?: string } };
  };
  return { status: response.status, body };
}

const mode = env.TENANCY_MODE;
afterAll(() => {
  env.TENANCY_MODE = mode;
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetAuthorizationPolicyForTests();
});

describe.each(FAMILIES)('%s: %s', (_family, method, path, handler) => {
  it('at multi, refuses a platform admin in a customer org as their org role there, and writes nothing (t-1032)', async () => {
    env.TENANCY_MODE = 'multi';
    adminIn(CUSTOMER);

    const { status, body } = await send(method, path, handler);

    expect(status).toBe(403);
    // The policy's refusal: the install-org one is for whoever may administer.
    expect(body.error?.details?.reason).not.toBe(SHARED_SETTINGS_REFUSAL_CODE);
    expect(writesMade()).toEqual([]);
  });

  it('at multi, refuses a customer org a policy admits, with the install-org message, and writes nothing', async () => {
    env.TENANCY_MODE = 'multi';
    forkAdmitsOwnerIn(CUSTOMER);

    const { status, body } = await send(method, path, handler);

    expect(status).toBe(403);
    expect(body.error?.message).toBe(SHARED_SETTINGS_REFUSAL);
    expect(body.error?.details?.reason).toBe(SHARED_SETTINGS_REFUSAL_CODE);
    expect(writesMade()).toEqual([]);
  });

  it('at multi, lets the install org through to the handler', async () => {
    env.TENANCY_MODE = 'multi';
    adminIn(INSTALL_ORG_ID);

    const { status, body } = await send(method, path, handler);

    expect(status).not.toBe(403);
    expect(body.error?.details?.reason).not.toBe(SHARED_SETTINGS_REFUSAL_CODE);
  });

  it('at single, changes nothing: the same customer-org session reaches the handler', async () => {
    env.TENANCY_MODE = 'single';
    adminIn(CUSTOMER);

    const { status, body } = await send(method, path, handler);

    expect(status).not.toBe(403);
    expect(body.error?.details?.reason).not.toBe(SHARED_SETTINGS_REFUSAL_CODE);
  });
});
