/**
 * Integration: shared-settings writes refuse a customer org at multi (§107 t-751)
 *
 * One write route per family, through the real `withAdminAuth`: a platform
 * admin switched into a customer org is refused with the install-org message
 * and nothing is written; from the install org, and at `single`, the guard
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
  SHARED_SETTINGS_REFUSAL_REASON,
} from '@/lib/tenancy/shared-settings';
import { mockAdminUser } from '@/tests/helpers/auth';

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
});

describe.each(FAMILIES)('%s: %s', (_family, method, path, handler) => {
  it('at multi, refuses a platform admin in a customer org, and writes nothing', async () => {
    env.TENANCY_MODE = 'multi';
    adminIn(CUSTOMER);

    const { status, body } = await send(method, path, handler);

    expect(status).toBe(403);
    expect(body.error?.message).toBe(SHARED_SETTINGS_REFUSAL);
    expect(body.error?.details?.reason).toBe(SHARED_SETTINGS_REFUSAL_REASON);
    expect(writesMade()).toEqual([]);
  });

  it('at multi, lets the install org through to the handler', async () => {
    env.TENANCY_MODE = 'multi';
    adminIn(INSTALL_ORG_ID);

    const { status, body } = await send(method, path, handler);

    expect(status).not.toBe(403);
    expect(body.error?.details?.reason).not.toBe(SHARED_SETTINGS_REFUSAL_REASON);
  });

  it('at single, changes nothing: the same customer-org session reaches the handler', async () => {
    env.TENANCY_MODE = 'single';
    adminIn(CUSTOMER);

    const { status, body } = await send(method, path, handler);

    expect(status).not.toBe(403);
    expect(body.error?.details?.reason).not.toBe(SHARED_SETTINGS_REFUSAL_REASON);
  });
});
