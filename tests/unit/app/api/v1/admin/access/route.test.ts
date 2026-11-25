/**
 * Tests: GET /api/v1/admin/access (§143 t-1090)
 *
 * The guard is stood in for, handing the handler the principal a real guard
 * would; the policy is the real default policy at `multi`. So who is admitted
 * and what each sees is the policy's answer, not this file's:
 *
 * - a platform admin, an org OWNER/ADMIN and a holder of a named tier each get
 *   their own slice; a holder's response carries none of the org admin's pages;
 * - an org MEMBER holding nothing is refused with a 403, as is an org admin
 *   at `single`, where no org role opens the console;
 * - a failed read of the org's switches is said, not guessed;
 * - an app key naming a group of strings, not one, is shown as the key.
 *
 * @see app/api/v1/admin/access/route.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/auth/guards', () => ({
  withAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    async (request: unknown, session: unknown) => {
      const { handleAPIError } = await import('@/lib/api/errors');
      try {
        return await handler(request, session);
      } catch (error) {
        return handleAPIError(error);
      }
    },
}));
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn(async () => mockLog) }));
const mockPrisma = vi.hoisted(() => ({ org: { findUnique: vi.fn() } }));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
// The real catalogue, plus an app namespace with a group of strings in it.
vi.mock('next-intl/server', async () => {
  await import('next-intl');
  const { nextIntlServerMock, translatorFor } = await import('@/tests/helpers/i18n');
  const { default: en } = await import('@/lib/i18n/messages/en.json');
  const messages = { ...en, app: { access: { agency: { label: 'Agency' } } } };
  return { ...nextIntlServerMock, getTranslations: async () => translatorFor(undefined, messages) };
});

import * as route from '@/app/api/v1/admin/access/route';
import { createMockRequest } from '@/tests/helpers/api';
import { parseJSON } from '@/tests/helpers/assertions';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';
import type { AccessExplainer } from '@/lib/auth/access-explainer';
import { registerAdminTier, registerOrgTierAdminPage } from '@/lib/auth/admin-tier';
import { adminReachOf } from '@/lib/auth/admin-reach';
import { __resetAccessExplainerForTests } from '@/lib/auth/access-explainer';
import { registerAccessArea } from '@/lib/auth/access-explainer-registry';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
} from '@/lib/tenancy/entitlements';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { env } from '@/lib/env';

type Handler = (req: Request, session: unknown) => Promise<Response>;
const GET = route.GET as unknown as Handler;

const ORG = 'cmorg00000000000000000orga';
const DESIGNER_ID = 'designer-1';

const ORG_ADMIN: AuthorizationPrincipal = {
  userId: 'oadmin-1',
  role: 'USER',
  credential: 'session',
  orgId: ORG,
  orgRole: 'ADMIN',
};
const DESIGNER: AuthorizationPrincipal = { ...ORG_ADMIN, userId: DESIGNER_ID, orgRole: 'MEMBER' };
const MEMBER: AuthorizationPrincipal = { ...ORG_ADMIN, userId: 'member-1', orgRole: 'MEMBER' };
const PLATFORM_ADMIN: AuthorizationPrincipal = {
  userId: 'admin-1',
  role: 'ADMIN',
  credential: 'session',
  orgId: INSTALL_ORG_ID,
  orgRole: 'OWNER',
};

async function call(principal: AuthorizationPrincipal) {
  const response = await GET(
    createMockRequest({ method: 'GET', url: 'http://localhost:3000/api/v1/admin/access' }),
    { principal, user: { id: principal.userId }, session: {} }
  );
  return {
    status: response.status,
    body: await parseJSON<{ success: boolean; data: AccessExplainer }>(response),
  };
}

function pagesOf(explainer: AccessExplainer): string[] {
  return (explainer.areas ?? []).flatMap((area) => area.pages.map((page) => page.pattern));
}

let previousMode: typeof env.TENANCY_MODE;
beforeEach(() => {
  vi.clearAllMocks();
  previousMode = env.TENANCY_MODE;
  env.TENANCY_MODE = 'multi';
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
  registerEntitlementSwitch({
    key: 'lead_gen',
    label: 'Lead generation',
    description: 'Funnels and leads.',
    whenLacking: 'lock',
  });
  registerAdminTier('designers', {
    holds: (viewer) => viewer.userId === DESIGNER_ID,
    label: 'Agency designers',
  });
  registerOrgTierAdminPage('/admin/designs', { tier: 'designers' });
  registerOrgTierAdminPage('/admin/leads', { requires: 'lead_gen' });
  mockPrisma.org.findUnique.mockResolvedValue({ settings: { entitlements: { on: [], off: [] } } });
});
afterEach(() => {
  env.TENANCY_MODE = previousMode;
  __resetAccessExplainerForTests();
  __resetAppOrgTierAdminPagesForTests();
  __resetEntitlementRegistryForTests();
});

describe('GET /api/v1/admin/access', () => {
  it('gives a platform admin every page, tier and switch', async () => {
    const { status, body } = await call(PLATFORM_ADMIN);

    expect(status).toBe(200);
    expect(body.data.audience).toBe('platform');
    expect(pagesOf(body.data)).toEqual(expect.arrayContaining(['/admin/designs', '/admin/leads']));
    expect(body.data.roles?.map((role) => role.key)).toContain('designers');
    expect(body.data.switches?.map((s) => [s.key, s.held])).toEqual([['lead_gen', null]]);
    // Switches do not limit a platform admin, so the org's are not read.
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled();
  });

  it("gives an org admin their org's view, with a page their org lacks shown locked", async () => {
    const { status, body } = await call(ORG_ADMIN);

    expect(status).toBe(200);
    expect(body.data.audience).toBe('org');
    expect(body.data.you).toMatchObject({ orgRole: 'ADMIN', tiers: ['org', 'designers'] });
    const leads = body.data.areas
      ?.flatMap((area) => area.pages)
      .find((page) => page.pattern === '/admin/leads');
    expect(leads).toMatchObject({ opens: false, locked: { label: 'Lead generation' } });
    expect(pagesOf(body.data)).toContain('/admin/orchestration/agents');
  });

  it("gives a holder their tier's pages and nothing of the org admin's", async () => {
    const { status, body } = await call(DESIGNER);

    expect(status).toBe(200);
    expect(body.data.audience).toBe('holder');
    expect(pagesOf(body.data)).toEqual(['/admin/designs']);
    expect(body.data.roles?.map((role) => role.key)).toEqual(['designers']);
    expect(body.data.platformOnly).toEqual([]);
  });

  it('refuses a member who holds nothing', async () => {
    const { status, body } = await call(MEMBER);

    expect(status).toBe(403);
    expect(body.success).toBe(false);
  });

  it('refuses an org admin at single, where no org role opens the console', async () => {
    env.TENANCY_MODE = 'single';
    const { status } = await call(ORG_ADMIN);
    expect(status).toBe(403);
  });

  it('gives an admin-scoped key held by a platform admin, entered into no org, the platform view', async () => {
    const { orgId: _none, orgRole: _role, ...unbound } = PLATFORM_ADMIN;
    const { status, body } = await call({ ...unbound, credential: 'api-key', scopes: ['admin'] });

    expect(status).toBe(200);
    expect(body.data.audience).toBe('platform');
    expect(body.data.you).toMatchObject({ orgRole: null, tiers: 'platform' });
  });

  it('refuses an API key that is not admin-scoped, whoever holds it', async () => {
    const { status } = await call({ ...ORG_ADMIN, credential: 'api-key', scopes: ['chat'] });
    expect(status).toBe(403);
  });

  it('treats an org whose row has gone as switches it could not read', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(null);

    const { status, body } = await call(ORG_ADMIN);

    expect(status).toBe(200);
    expect(body.data.you).toMatchObject({ switchesUnreadable: true, switchesOn: null });
  });

  it("reads the org's switches once for what it has and what it is shown locked", async () => {
    // What the policy reads on its own to work out the reach...
    await adminReachOf(ORG_ADMIN, { org: ORG });
    const policyReads = mockPrisma.org.findUnique.mock.calls.length;
    mockPrisma.org.findUnique.mockClear();

    const { body } = await call(ORG_ADMIN);

    // ...and one read more by the route, not one per thing it shows.
    expect(mockPrisma.org.findUnique).toHaveBeenCalledTimes(policyReads + 1);
    expect(body.data.you?.switchesOn).toEqual([]);
    expect(body.data.switches?.find((s) => s.key === 'lead_gen')).toMatchObject({ held: false });
  });

  it('shows an app key naming a group of strings as the key, and one naming a string as it', async () => {
    registerAccessArea({
      key: 'agency',
      label: { message: 'app.access.agency' },
      pages: ['/admin/designs'],
    });
    registerAccessArea({
      key: 'leads',
      label: { message: 'app.access.agency.label' },
      pages: ['/admin/leads'],
    });

    const { body } = await call(PLATFORM_ADMIN);

    const labelOf = (key: string) => body.data.areas?.find((area) => area.key === key)?.label;
    expect(labelOf('agency')).toBe('app.access.agency');
    expect(labelOf('leads')).toBe('Agency');
  });

  it("says it could not read the org's switches rather than guess", async () => {
    mockPrisma.org.findUnique.mockRejectedValue(new Error('db down'));

    const { status, body } = await call(ORG_ADMIN);

    expect(status).toBe(200);
    expect(body.data.you).toMatchObject({ switchesUnreadable: true, switchesOn: null });
    expect(mockLog.error).toHaveBeenCalledWith(
      "access explainer: could not read the org's switches",
      expect.objectContaining({ orgId: ORG })
    );
  });
});
