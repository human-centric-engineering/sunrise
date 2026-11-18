/**
 * Tests: a route that requires an entitlement switch (§135 t-1034)
 *
 * `withAdminAuth(handler, { tier, requires })` hands the switch to the policy
 * as `scope.requires`. Pinned here, through the guard and the real default
 * policy:
 *
 * - an org admin whose org has the switch runs the handler; one whose org
 *   lacks it gets a 403 that names the switch by its label and says who can
 *   change it, with `details.reason: 'entitlement_required'`;
 * - a platform admin is not limited by it;
 * - a caller refused for another reason gets the ordinary refusal, not one
 *   that talks about the org's switches;
 * - a platform-tier route, or one in a section the fork closed, passes no
 *   requirement; and a route that declares none answers as before.
 *
 * The org entry, the policy and the switch registry are real; Prisma and the
 * session are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_ORG_ROLE, ORG_ADMIN_ROLE, ORG_OWNER_ROLE } from '@/lib/tenancy/roles';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockPrisma = vi.hoisted(() => ({
  orgMembership: { findUnique: vi.fn() },
  org: { findMany: vi.fn(), findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

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
const fork = vi.hoisted(() => ({ switches: (): void => {}, tiers: (): void => {} }));
vi.mock('@/lib/app/entitlements', () => ({ initAppEntitlements: () => fork.switches() }));
vi.mock('@/lib/app/admin-tier', () => ({ initAppOrgTierAdminPages: () => fork.tiers() }));

import { headers } from 'next/headers';
import { auth } from '@/lib/auth/config';
import { withAdminAuth } from '@/lib/auth/guards';
import { closeCoreOrgTierSection } from '@/lib/auth/admin-tier';
import { __resetAppOrgTierAdminPagesForTests } from '@/lib/auth/org-tier-admin-pages';
import { __resetAuthorizationPolicyForTests } from '@/lib/auth/authorization';
import {
  __resetEntitlementRegistryForTests,
  registerEntitlementSwitch,
  SWITCH_REQUIRED_REASON,
} from '@/lib/tenancy/entitlements';

const ORG = 'cmorg000000000000000other';
const OWNED = {
  ownership: { decidedBy: 'nothing', because: 'Fixture: about the guard, not the rows.' },
} as const;
const LEADS = { tier: 'org', requires: 'lead_gen', ...OWNED } as const;
const REFUSAL =
  "Your organisation does not have Lead generation. Ask whoever manages your organisation's account to switch it on.";

function session(role: 'USER' | 'ADMIN', activeOrgId: string | null) {
  return {
    session: {
      id: 'session_1',
      userId: 'user_1',
      token: 'tok',
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(),
      updatedAt: new Date(),
      activeOrgId,
    },
    user: {
      id: 'user_1',
      name: 'Test User',
      email: 'test@example.com',
      emailVerified: true,
      image: null,
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function signedIn(role: 'USER' | 'ADMIN', orgRole: string, orgId: string | null = ORG) {
  vi.mocked(auth.api.getSession).mockResolvedValue(session(role, orgId));
  mockPrisma.orgMembership.findUnique.mockResolvedValue({
    role: orgRole,
    org: { status: 'ACTIVE' },
  });
}

/** The entered org's stored switches. */
function orgHas(on: string[]) {
  mockPrisma.org.findUnique.mockResolvedValue({ settings: { entitlements: { on, off: [] } } });
}

function route(options: Parameters<typeof withAdminAuth>[1], path = '/api/v1/app/leads') {
  const ran: string[] = [];
  const handler = withAdminAuth(() => {
    ran.push('ran');
    return Response.json({ success: true });
  }, options);
  return {
    ran,
    call: async () => {
      const res = await handler(new NextRequest(`http://localhost:3000${path}`));
      return {
        status: res.status,
        body: (await res.json()) as {
          error?: { message: string; details?: Record<string, unknown> };
        },
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.TENANCY_MODE = 'multi';
  vi.mocked(headers).mockResolvedValue(new Headers());
  __resetEntitlementRegistryForTests();
  __resetAppOrgTierAdminPagesForTests();
  fork.tiers = () => {};
  fork.switches = () => {
    registerEntitlementSwitch({ key: 'lead_gen', label: 'Lead generation', description: '' });
  };
  orgHas([]);
});
afterEach(() => {
  __resetAuthorizationPolicyForTests();
  __resetEntitlementRegistryForTests();
  __resetAppOrgTierAdminPagesForTests();
});

describe('withAdminAuth({ tier, requires }) (t-1034)', () => {
  it.each([ORG_OWNER_ROLE, ORG_ADMIN_ROLE])(
    'runs the handler for an org %s whose org has the switch',
    async (role) => {
      signedIn('USER', role);
      orgHas(['lead_gen']);
      const { call, ran } = route(LEADS);
      expect((await call()).status).toBe(200);
      expect(ran).toEqual(['ran']);
    }
  );

  it('refuses an org admin whose org lacks it, naming the switch by its label and the remedy', async () => {
    signedIn('USER', ORG_ADMIN_ROLE);
    const { call, ran } = route(LEADS);
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body.error?.message).toBe(REFUSAL);
    expect(body.error?.details).toEqual({
      reason: SWITCH_REQUIRED_REASON,
      requires: 'lead_gen',
    });
    expect(ran).toEqual([]);
  });

  it('does not limit a platform admin, even acting in an org that lacks the switch', async () => {
    signedIn('ADMIN', ORG_ADMIN_ROLE, ORG);
    const { call, ran } = route(LEADS);
    expect((await call()).status).toBe(200);
    expect(ran).toEqual(['ran']);
  });

  it('gives someone the tier refuses anyway the ordinary refusal, which says nothing of switches', async () => {
    signedIn('USER', DEFAULT_ORG_ROLE);
    const { call, ran } = route(LEADS);
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body.error?.message).toBe('Admin access required');
    expect(body.error?.details).toBeUndefined();
    expect(ran).toEqual([]);
  });

  it('names an unregistered switch by its key: no org has it, so the refusal is true', async () => {
    signedIn('USER', ORG_ADMIN_ROLE);
    orgHas(['typo_gen']);
    const { call } = route({ ...LEADS, requires: 'typo_gen' });
    const { status, body } = await call();
    expect(status).toBe(403);
    expect(body.error?.message).toBe(
      "Your organisation does not have typo_gen. Ask whoever manages your organisation's account to switch it on."
    );
  });

  it('answers as before for a route that requires nothing — no switch read', async () => {
    signedIn('USER', ORG_ADMIN_ROLE);
    const { call, ran } = route({ tier: 'org', ...OWNED });
    expect((await call()).status).toBe(200);
    expect(ran).toEqual(['ran']);
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — behaviour-neutral at rest: no requirement, no read;
  });

  it('passes no requirement where the tier is gone: the section is closed, so the route is the platform’s', async () => {
    fork.tiers = () => closeCoreOrgTierSection('orchestration');
    signedIn('USER', ORG_ADMIN_ROLE);
    orgHas(['lead_gen']);
    const { call } = route(LEADS, '/api/v1/admin/orchestration/leads');
    const { status, body } = await call();
    // Refused as a platform route, not for the switch the org has.
    expect(status).toBe(403);
    expect(body.error?.message).toBe('Admin access required');
  });
});
