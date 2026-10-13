/**
 * Tests for `lib/orchestration/backup/scope.ts`
 *
 * `resolveBackupScope()` decides which org a backup touches and whether it
 * carries the shared part. The tenancy mode, the active org, the org lookup
 * and the authorization policy are the inputs, so those are mocked; the
 * errors, the query schema and the decision logic are real.
 *
 * @see lib/orchestration/backup/scope.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockIsMultiTenant = vi.hoisted(() => vi.fn(() => false));
const mockGetTenantContext = vi.hoisted(() =>
  vi.fn((): { orgId: string | null; source: string } | null => null)
);
const mockOrgFindUnique = vi.hoisted(() => vi.fn());
const mockCanAdminister = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));

vi.mock('@/lib/tenancy/context', () => ({
  isMultiTenant: mockIsMultiTenant,
  getTenantContext: mockGetTenantContext,
}));
vi.mock('@/lib/db/client', () => ({
  prisma: { org: { findUnique: mockOrgFindUnique } },
}));
vi.mock('@/lib/auth/authorization', () => ({ canAdminister: mockCanAdminister }));

import {
  BACKUP_SHARED_REFUSAL,
  backupScopeQuerySchema,
  resolveBackupScope,
} from '@/lib/orchestration/backup/scope';
import { APIError, ForbiddenError, NotFoundError, ValidationError } from '@/lib/api/errors';
import type { AuthorizationPrincipal } from '@/lib/auth/authorization';

const SESSION: AuthorizationPrincipal = { userId: 'user-1', role: 'ADMIN', credential: 'session' };
const API_KEY: AuthorizationPrincipal = {
  userId: 'user-1',
  role: 'ADMIN',
  credential: 'api-key',
  scopes: ['admin'],
};

function inOrg(orgId: string) {
  mockGetTenantContext.mockReturnValue({ orgId, source: 'session' });
}

/** Run `fn` and return the thrown value, failing if nothing was thrown. */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

beforeEach(() => {
  mockIsMultiTenant.mockReset();
  mockIsMultiTenant.mockReturnValue(false);
  mockGetTenantContext.mockReset();
  mockGetTenantContext.mockReturnValue(null);
  mockOrgFindUnique.mockReset();
  mockOrgFindUnique.mockResolvedValue({ id: 'org_other' });
  mockCanAdminister.mockReset();
  mockCanAdminister.mockResolvedValue(true);
});

describe('backupScopeQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(backupScopeQuerySchema.parse({})).toEqual({});
  });

  it('accepts the install org literal and a cuid-shaped id', () => {
    expect(backupScopeQuerySchema.parse({ orgId: 'install' }).orgId).toBe('install');
    expect(backupScopeQuerySchema.parse({ orgId: 'cmtd5heg2001804ky8pgo6odx' }).orgId).toBe(
      'cmtd5heg2001804ky8pgo6odx'
    );
  });

  it('rejects a malformed orgId', () => {
    expect(backupScopeQuerySchema.safeParse({ orgId: 'bad id/../x' }).success).toBe(false);
    expect(backupScopeQuerySchema.safeParse({ orgId: '' }).success).toBe(false);
  });

  it("accepts only 'true' or 'false' for shared", () => {
    expect(backupScopeQuerySchema.safeParse({ shared: 'true' }).success).toBe(true);
    expect(backupScopeQuerySchema.safeParse({ shared: 'false' }).success).toBe(true);
    expect(backupScopeQuerySchema.safeParse({ shared: '1' }).success).toBe(false);
    expect(backupScopeQuerySchema.safeParse({ shared: 'TRUE' }).success).toBe(false);
  });
});

describe('resolveBackupScope — single tenancy', () => {
  it('targets the install org when no orgId is given', async () => {
    const scope = await resolveBackupScope({}, SESSION);

    expect(scope.orgId).toBe('install');
  });

  it('accepts the install org named explicitly', async () => {
    const scope = await resolveBackupScope({ orgId: 'install' }, SESSION);

    expect(scope.orgId).toBe('install');
  });

  it('refuses any other org with a ValidationError', async () => {
    const error = await thrown(() => resolveBackupScope({ orgId: 'org_other' }, SESSION));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain('one organisation');
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
  });

  it('includes the shared part by default', async () => {
    expect((await resolveBackupScope({}, SESSION)).includeShared).toBe(true);
  });

  it('honours shared=false', async () => {
    expect((await resolveBackupScope({ shared: 'false' }, SESSION)).includeShared).toBe(false);
  });

  it('honours shared=true', async () => {
    expect((await resolveBackupScope({ shared: 'true' }, SESSION)).includeShared).toBe(true);
  });

  it('does no org lookup or policy check', async () => {
    await resolveBackupScope({}, SESSION);

    expect(mockOrgFindUnique).not.toHaveBeenCalled();
    expect(mockCanAdminister).not.toHaveBeenCalled();
  });
});

describe('resolveBackupScope — multi tenancy, org resolution', () => {
  beforeEach(() => {
    mockIsMultiTenant.mockReturnValue(true);
  });

  it('defaults to the active org with no database read or policy check', async () => {
    inOrg('org_active');

    const scope = await resolveBackupScope({}, SESSION);

    expect(scope.orgId).toBe('org_active');
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
    expect(mockCanAdminister).not.toHaveBeenCalled();
  });

  it('needs no extra checks when orgId names the active org', async () => {
    inOrg('org_active');

    const scope = await resolveBackupScope({ orgId: 'org_active' }, SESSION);

    expect(scope.orgId).toBe('org_active');
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
    expect(mockCanAdminister).not.toHaveBeenCalled();
  });

  it('checks existence and the policy for an org other than the active one', async () => {
    inOrg('org_active');

    const scope = await resolveBackupScope({ orgId: 'org_other' }, SESSION);

    expect(scope.orgId).toBe('org_other');
    expect(mockOrgFindUnique).toHaveBeenCalledWith({
      where: { id: 'org_other' },
      select: { id: true },
    });
    expect(mockCanAdminister).toHaveBeenCalledWith(
      SESSION,
      { kind: 'org', id: 'org_other', orgId: 'org_other' },
      { org: 'org_active' }
    );
  });

  it('throws NotFoundError, before asking the policy, when the org does not exist', async () => {
    inOrg('org_active');
    mockOrgFindUnique.mockResolvedValue(null);

    const error = await thrown(() => resolveBackupScope({ orgId: 'org_gone' }, SESSION));

    expect(error).toBeInstanceOf(NotFoundError);
    expect(mockCanAdminister).not.toHaveBeenCalled();
  });

  it('throws ForbiddenError when the policy refuses the named org', async () => {
    inOrg('org_active');
    mockCanAdminister.mockResolvedValue(false);

    const error = await thrown(() => resolveBackupScope({ orgId: 'org_other' }, SESSION));

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(mockCanAdminister).toHaveBeenCalledOnce();
  });

  it('refuses an unbound API key that names no org', async () => {
    const error = await thrown(() => resolveBackupScope({}, API_KEY));

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).message).toContain('?orgId=');
    expect(mockOrgFindUnique).not.toHaveBeenCalled();
  });

  it('resolves the org an unbound API key names, asking the policy with an empty scope', async () => {
    const scope = await resolveBackupScope({ orgId: 'org_other' }, API_KEY);

    expect(scope.orgId).toBe('org_other');
    expect(mockCanAdminister).toHaveBeenCalledWith(
      API_KEY,
      { kind: 'org', id: 'org_other', orgId: 'org_other' },
      {}
    );
  });
});

describe('resolveBackupScope — multi tenancy, shared part', () => {
  beforeEach(() => {
    mockIsMultiTenant.mockReturnValue(true);
  });

  it('leaves the shared part out by default, even for the install org', async () => {
    inOrg('install');

    expect((await resolveBackupScope({}, SESSION)).includeShared).toBe(false);
  });

  it('includes it for the install org when asked for', async () => {
    inOrg('install');

    const scope = await resolveBackupScope({ shared: 'true' }, SESSION);

    expect(scope).toEqual({ orgId: 'install', includeShared: true });
  });

  it('includes it when the install org is named from another org the caller administers', async () => {
    inOrg('org_active');

    const scope = await resolveBackupScope({ orgId: 'install', shared: 'true' }, SESSION);

    expect(scope).toEqual({ orgId: 'install', includeShared: true });
  });

  it('refuses a customer org that asks for it, with the install-org-only reason', async () => {
    inOrg('org_active');

    const error = await thrown(() => resolveBackupScope({ shared: 'true' }, SESSION));

    expect(error).toBeInstanceOf(APIError);
    expect(error).not.toBeInstanceOf(ForbiddenError);
    const apiError = error as APIError;
    expect(apiError.status).toBe(403);
    expect(apiError.message).toBe(BACKUP_SHARED_REFUSAL);
    expect(apiError.details).toEqual({ reason: 'shared_settings_install_org_only' });
  });

  it('refuses a customer org named from the install org that asks for it', async () => {
    inOrg('install');

    const error = await thrown(() =>
      resolveBackupScope({ orgId: 'org_other', shared: 'true' }, SESSION)
    );

    expect((error as APIError).details).toEqual({ reason: 'shared_settings_install_org_only' });
  });

  it('allows an unbound API key to ask for it for a customer org', async () => {
    const scope = await resolveBackupScope({ orgId: 'org_other', shared: 'true' }, API_KEY);

    expect(scope).toEqual({ orgId: 'org_other', includeShared: true });
  });

  it('never refuses shared=false', async () => {
    inOrg('org_active');

    const scope = await resolveBackupScope({ shared: 'false' }, SESSION);

    expect(scope).toEqual({ orgId: 'org_active', includeShared: false });
  });
});
