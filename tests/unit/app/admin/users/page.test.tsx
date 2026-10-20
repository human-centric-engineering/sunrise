// @vitest-environment happy-dom

/**
 * Unit Tests: AdminUsersPage (app/admin/users/page.tsx)
 *
 * The page loads the users and the pending invitations in parallel and hands
 * both to `UserManagementTabs`. A failed users load (5xx, success:false, no
 * response) throws to the admin error boundary instead of rendering "No users
 * found" (#518). A failed invitations load hands the tabs `null`, so the
 * invitations tab shows a notice — never an empty "Pending Invitations" tab —
 * and the users tab still renders. Real empty lists still render as empty.
 *
 * Only `serverFetch` is faked: the real parser and `requireServerData` run.
 * No auth-redirect test: the admin guard lives in `app/admin/layout.tsx`.
 *
 * @see app/admin/users/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const tabsProps = vi.fn();
vi.mock('@/components/admin/user-management-tabs', () => ({
  UserManagementTabs: (props: unknown) => {
    tabsProps(props);
    return <div data-testid="user-management-tabs" />;
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import AdminUsersPage from '@/app/admin/users/page';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { API } from '@/lib/api/endpoints';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess } from '@/tests/helpers/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USERS_PATH = `${API.USERS.LIST}?limit=20&sortBy=createdAt&sortOrder=desc`;
const INVITATIONS_PATH = `${API.ADMIN.INVITATIONS}?limit=20&sortBy=invitedAt&sortOrder=desc`;

const USER = {
  id: 'u-1',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'USER',
  emailVerified: true,
  image: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const INVITATION = {
  email: 'new@example.com',
  name: 'New',
  role: 'USER',
  invitedBy: 'u-1',
  invitedByName: 'Ada',
  invitedAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-10-08T00:00:00.000Z',
};

/** Answer each path with its `Response`; anything unmapped is a 404. */
function serve(responses: Record<string, () => Response | Promise<never>>) {
  vi.mocked(serverFetch).mockImplementation(async (path: string) => {
    const answer = responses[path];
    return answer ? answer() : apiFailure(404, 'NOT_FOUND');
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminUsersPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands both lists, with real dates and their meta, to the tabs', async () => {
    const usersMeta = { page: 1, limit: 20, total: 41, totalPages: 3 };
    serve({
      [USERS_PATH]: () => apiSuccess([USER], usersMeta),
      [INVITATIONS_PATH]: () => apiSuccess([INVITATION]),
    });

    render(await AdminUsersPage());

    expect(screen.getByTestId('user-management-tabs')).toBeInTheDocument();
    expect(tabsProps).toHaveBeenCalledWith({
      users: [{ ...USER, createdAt: new Date(USER.createdAt), erasureRequestedAt: null }],
      usersMeta,
      invitations: [
        {
          ...INVITATION,
          invitedAt: new Date(INVITATION.invitedAt),
          expiresAt: new Date(INVITATION.expiresAt),
        },
      ],
      // No meta sent → one complete page.
      invitationsMeta: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });
  });

  it('renders empty lists as empty lists', async () => {
    serve({
      [USERS_PATH]: () => apiSuccess([]),
      [INVITATIONS_PATH]: () => apiSuccess([]),
    });

    render(await AdminUsersPage());

    expect(tabsProps).toHaveBeenCalledWith(
      expect.objectContaining({
        users: [],
        invitations: [],
        usersMeta: { page: 1, limit: 20, total: 0, totalPages: 1 },
      })
    );
  });

  // ── A failed load is a failure, not an empty table (#518) ───────────────

  it('throws to the error boundary when the users API answers 500', async () => {
    serve({
      [USERS_PATH]: () => apiFailure(500),
      [INVITATIONS_PATH]: () => apiSuccess([]),
    });

    await expect(AdminUsersPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), undefined, {
      path: USERS_PATH,
      status: 500,
      code: 'INTERNAL_ERROR',
    });
  });

  it('throws, and logs, when the users fetch rejects', async () => {
    const failure = new Error('ECONNREFUSED');
    serve({
      [USERS_PATH]: () => Promise.reject(failure),
      [INVITATIONS_PATH]: () => apiSuccess([]),
    });

    await expect(AdminUsersPage()).rejects.toBeInstanceOf(ServerLoadError);
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure, {
      path: USERS_PATH,
    });
  });

  it('renders the users and hands the tabs null invitations when that API answers success:false', async () => {
    serve({
      [USERS_PATH]: () => apiSuccess([USER]),
      [INVITATIONS_PATH]: () => apiFailure(200),
    });

    render(await AdminUsersPage());

    expect(screen.getByTestId('user-management-tabs')).toBeInTheDocument();
    expect(tabsProps).toHaveBeenCalledWith({
      users: [{ ...USER, createdAt: new Date(USER.createdAt), erasureRequestedAt: null }],
      usersMeta: { page: 1, limit: 20, total: 1, totalPages: 1 },
      // null, not [] — an empty tab would read as "none pending".
      invitations: null,
      invitationsMeta: null,
    });
  });

  it('hands the tabs null invitations, and logs, when the invitations fetch rejects', async () => {
    const failure = new Error('ECONNREFUSED');
    serve({
      [USERS_PATH]: () => apiSuccess([USER]),
      [INVITATIONS_PATH]: () => Promise.reject(failure),
    });

    render(await AdminUsersPage());

    expect(tabsProps).toHaveBeenCalledWith(
      expect.objectContaining({ invitations: null, invitationsMeta: null })
    );
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure, {
      path: INVITATIONS_PATH,
    });
  });
});
