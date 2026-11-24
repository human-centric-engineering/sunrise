/**
 * Tests for `lib/tenancy/target-org.ts` (t-1083)
 *
 * `resolveTargetOrg()` decides which org a route that takes `?orgId=` acts
 * on; `runInTargetOrg()` runs the work there. The mode, the org lookup and the
 * policy are mocked; the tenant context is the real one, so what
 * `runInTargetOrg` enters is read back rather than asserted on a mock.
 *
 * @see lib/tenancy/target-org.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'multi' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

const mockOrgFindUnique = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db/client', () => ({
  prisma: { org: { findUnique: mockOrgFindUnique } },
}));

const mockCanAdminister = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock('@/lib/auth/authorization', () => ({ canAdminister: mockCanAdminister }));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  resolveTargetOrg,
  runInTargetOrg,
  targetOrgQuerySchema,
  type ResolveTargetOrgOptions,
} from '@/lib/tenancy/target-org';
import { getTenantContext, runAsOrg } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';

const ADMIN: AuthorizationPrincipal = { userId: 'user-1', role: 'ADMIN', credential: 'session' };
const CUSTOMER_ORG = 'cmorg00000000000000000orga';
const OPTIONS: ResolveTargetOrgOptions = { noOrgMessage: 'name one' };

/** Resolve as a caller whose guard entered `orgId`. */
function resolveIn(orgId: string, named: string | undefined, options = OPTIONS) {
  return runAsOrg(orgId, () => resolveTargetOrg(named, ADMIN, options), { source: 'session' });
}

beforeEach(() => {
  mockEnv.TENANCY_MODE = 'multi';
  mockOrgFindUnique.mockReset();
  mockOrgFindUnique.mockResolvedValue({ status: 'ACTIVE' });
  mockCanAdminister.mockReset();
  mockCanAdminister.mockResolvedValue(true);
});

describe('targetOrgQuerySchema', () => {
  it('accepts no orgId, the install org literal and a cuid; refuses a malformed one', () => {
    expect(targetOrgQuerySchema.parse({})).toEqual({});
    expect(targetOrgQuerySchema.parse({ orgId: INSTALL_ORG_ID }).orgId).toBe(INSTALL_ORG_ID);
    expect(targetOrgQuerySchema.parse({ orgId: CUSTOMER_ORG }).orgId).toBe(CUSTOMER_ORG);
    expect(targetOrgQuerySchema.safeParse({ orgId: 'bad id/../x' }).success).toBe(false);
  });
});

describe('resolveTargetOrg at single', () => {
  beforeEach(() => {
    mockEnv.TENANCY_MODE = 'single';
  });

  it('answers the install org, named or not', async () => {
    expect(await resolveTargetOrg(undefined, ADMIN, OPTIONS)).toBe(INSTALL_ORG_ID);
    expect(await resolveTargetOrg(INSTALL_ORG_ID, ADMIN, OPTIONS)).toBe(INSTALL_ORG_ID);
  });

  it('refuses any other org, without asking the policy', async () => {
    await expect(resolveTargetOrg(CUSTOMER_ORG, ADMIN, OPTIONS)).rejects.toBeInstanceOf(
      ValidationError
    );
    expect(mockCanAdminister).not.toHaveBeenCalled();
  });
});

describe('resolveTargetOrg at multi', () => {
  it('answers the entered org when nothing is named, without a lookup', async () => {
    expect(await resolveIn(INSTALL_ORG_ID, undefined)).toBe(INSTALL_ORG_ID);
    expect(mockCanAdminister).not.toHaveBeenCalled();
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
  });

  it('refuses a caller that entered no org and named none, with the route’s words', async () => {
    const error = await resolveTargetOrg(undefined, ADMIN, OPTIONS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toBe('name one');
  });

  it('answers a named org once the policy admits the caller to it, asked about that org', async () => {
    expect(await resolveIn(INSTALL_ORG_ID, CUSTOMER_ORG)).toBe(CUSTOMER_ORG);
    expect(mockCanAdminister).toHaveBeenCalledWith(
      ADMIN,
      { kind: 'org', id: CUSTOMER_ORG, orgId: CUSTOMER_ORG },
      { org: INSTALL_ORG_ID }
    );
  });

  it('refuses before the lookup when the policy says no, so existence does not leak', async () => {
    mockCanAdminister.mockResolvedValue(false);
    await expect(resolveIn(INSTALL_ORG_ID, CUSTOMER_ORG)).rejects.toBeInstanceOf(ForbiddenError);
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
  });

  it('answers 404 for an org that does not exist', async () => {
    mockOrgFindUnique.mockResolvedValue(null);
    await expect(resolveIn(INSTALL_ORG_ID, CUSTOMER_ORG)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('admits a suspended org unless the route refuses one', async () => {
    mockOrgFindUnique.mockResolvedValue({ status: 'SUSPENDED' });
    expect(await resolveIn(INSTALL_ORG_ID, CUSTOMER_ORG)).toBe(CUSTOMER_ORG);
    await expect(
      resolveIn(INSTALL_ORG_ID, CUSTOMER_ORG, { ...OPTIONS, suspendedMessage: 'closed' })
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('runInTargetOrg', () => {
  const orgSeen = () => Promise.resolve(getTenantContext());

  it('enters the named org as the caller’s source, without their entered-org role', async () => {
    const seen = await runAsOrg(INSTALL_ORG_ID, () => runInTargetOrg(CUSTOMER_ORG, orgSeen), {
      source: 'session',
      role: 'ADMIN',
    });
    expect(seen?.orgId).toBe(CUSTOMER_ORG);
    // An admin's request, not a background job; and no role, which was the
    // caller's role in the install org and says nothing about the target.
    expect(seen?.source).toBe('session');
    expect(seen?.role ?? null).toBeNull();
  });

  it('keeps an admin API key’s source in the named org', async () => {
    const seen = await runAsOrg(INSTALL_ORG_ID, () => runInTargetOrg(CUSTOMER_ORG, orgSeen), {
      source: 'api-key',
    });
    expect(seen).toMatchObject({ orgId: CUSTOMER_ORG, source: 'api-key' });
  });

  it('does not carry a support source or its stamp, which is consent for the entered org only', async () => {
    const support = { grantId: 'grant-1', level: 'ADMIN' as const, expiresAt: new Date() };
    const seen = await runAsOrg(INSTALL_ORG_ID, () => runInTargetOrg(CUSTOMER_ORG, orgSeen), {
      source: 'support',
      support,
    });
    expect(seen).toMatchObject({ orgId: CUSTOMER_ORG, source: 'job' });
    expect(seen?.support).toBeUndefined();
  });

  it('falls back to a job source when the caller entered no org', async () => {
    const seen = await runInTargetOrg(CUSTOMER_ORG, orgSeen);
    expect(seen).toMatchObject({ orgId: CUSTOMER_ORG, source: 'job' });
  });

  it('keeps the caller’s own context when the target is the entered org', async () => {
    const seen = await runAsOrg(INSTALL_ORG_ID, () => runInTargetOrg(INSTALL_ORG_ID, orgSeen), {
      source: 'session',
      role: 'ADMIN',
    });
    expect(seen).toMatchObject({ orgId: INSTALL_ORG_ID, source: 'session', role: 'ADMIN' });
  });

  it('enters nothing at single', async () => {
    mockEnv.TENANCY_MODE = 'single';
    expect(await runInTargetOrg(INSTALL_ORG_ID, orgSeen)).toBeNull();
  });
});
