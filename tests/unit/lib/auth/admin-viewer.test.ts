/**
 * Tests: administersPlatform — the platform question, asked inside an org-tier route (§111 t-811)
 *
 * It must answer as the admin layout's platform question does: a platform
 * admin and an `admin` API key yes, an org OWNER/ADMIN no — even on a surface
 * that admits them — because the tier is deliberately not passed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, TENANCY_MODE: 'multi' } };
});
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { administersPlatform } from '@/lib/auth/admin-viewer';
import {
  DEFAULT_AUTHORIZATION_POLICY,
  registerAuthorizationPolicy,
  __resetAuthorizationPolicyForTests,
  type AuthorizationPrincipal,
} from '@/lib/auth/authorization';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const ORG_B = 'cmorg0000000000000000orgb';

const orgAdmin: AuthorizationPrincipal = {
  userId: 'oadmin',
  role: 'USER',
  credential: 'session',
  orgId: ORG_B,
  orgRole: 'ADMIN',
};

beforeEach(() => __resetAuthorizationPolicyForTests());

describe('administersPlatform', () => {
  it('is true for a platform admin, in the install org or switched into a customer org', async () => {
    const admin: AuthorizationPrincipal = {
      userId: 'admin',
      role: 'ADMIN',
      credential: 'session',
      orgId: INSTALL_ORG_ID,
      orgRole: 'OWNER',
    };
    await expect(administersPlatform(admin)).resolves.toBe(true);
    await expect(administersPlatform({ ...admin, orgId: ORG_B, orgRole: null })).resolves.toBe(
      true
    );
  });

  it('is true for an admin API key, which enters no org', async () => {
    await expect(
      administersPlatform({ userId: 'k', role: 'ADMIN', credential: 'api-key', scopes: ['admin'] })
    ).resolves.toBe(true);
  });

  it('is false for an admin API key whose owner is no longer a platform admin (#746)', async () => {
    await expect(
      administersPlatform({ userId: 'k', role: 'USER', credential: 'api-key', scopes: ['admin'] })
    ).resolves.toBe(false);
  });

  it('is false for an org ADMIN of the entered org — the tier that admits them is not asked', async () => {
    await expect(administersPlatform(orgAdmin)).resolves.toBe(false);
  });

  it('asks the registered policy, with the entered org and no tier', async () => {
    const canAdminister = vi.fn(() => Promise.resolve(true));
    registerAuthorizationPolicy({ ...DEFAULT_AUTHORIZATION_POLICY, canAdminister });

    await expect(administersPlatform(orgAdmin)).resolves.toBe(true);
    expect(canAdminister).toHaveBeenCalledWith(orgAdmin, null, { org: ORG_B });

    const noOrg: AuthorizationPrincipal = { userId: 'x', role: 'USER', credential: 'session' };
    await administersPlatform(noOrg);
    expect(canAdminister).toHaveBeenLastCalledWith(noOrg, null, {});
  });
});
