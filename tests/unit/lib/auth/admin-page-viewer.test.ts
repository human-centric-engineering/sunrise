/**
 * Tests: adminPageViewerTier — who is viewing a mixed admin page (§111 t-812)
 *
 * The mixed pages render their platform-ops half for a platform viewer only,
 * so this must answer as the admin layout's platform question does: the
 * policy asked about the session's entered org, with no tier. An org
 * OWNER/ADMIN is an org viewer, and anything it cannot ask about is too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/utils', () => ({ getServerSession: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/auth/session-principal', () => ({ sessionPrincipal: vi.fn() }));
vi.mock('@/lib/auth/authorization', () => ({ canAdminister: vi.fn() }));

import { adminPageViewerTier } from '@/lib/auth/admin-page-viewer';
import { getServerSession } from '@/lib/auth/utils';
import { headers } from 'next/headers';
import { sessionPrincipal } from '@/lib/auth/session-principal';
import { canAdminister } from '@/lib/auth/authorization';
import { TENANT_HEADER_NAME } from '@/lib/tenancy/resolver';

const ORG_B = 'cmorg0000000000000000orgb';
const session = {
  session: { activeOrgId: ORG_B },
  user: { id: 'user_b', role: 'USER' },
};
const principal = {
  userId: 'user_b',
  role: 'USER',
  credential: 'session' as const,
  orgId: ORG_B,
  orgRole: 'ADMIN',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getServerSession).mockResolvedValue(session as never);
  vi.mocked(headers).mockResolvedValue(new Headers({ [TENANT_HEADER_NAME]: ORG_B }));
  vi.mocked(sessionPrincipal).mockResolvedValue({ principal, scope: { org: ORG_B } });
});

describe('adminPageViewerTier', () => {
  it('is the platform when the policy says this session administers it', async () => {
    vi.mocked(canAdminister).mockResolvedValue(true);

    await expect(adminPageViewerTier()).resolves.toBe('platform');
  });

  it('is an org viewer when it does not — the tier that admitted them is not asked', async () => {
    vi.mocked(canAdminister).mockResolvedValue(false);

    await expect(adminPageViewerTier()).resolves.toBe('org');
    expect(canAdminister).toHaveBeenCalledTimes(1);
    expect(canAdminister).toHaveBeenCalledWith(principal, null, { org: ORG_B });
  });

  it('enters the org the request names, as the layout does', async () => {
    vi.mocked(canAdminister).mockResolvedValue(false);

    await adminPageViewerTier();

    expect(sessionPrincipal).toHaveBeenCalledWith(session, ORG_B);
  });

  it('is an org viewer with no session, without asking the policy', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    await expect(adminPageViewerTier()).resolves.toBe('org');
    expect(canAdminister).not.toHaveBeenCalled();
  });
});
