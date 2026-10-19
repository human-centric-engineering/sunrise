// @vitest-environment happy-dom

/**
 * Unit Tests: AdminUserEditPage (app/admin/users/[id]/edit/page.tsx)
 *
 * The user is the record the page exists to edit:
 * - a 404, or an id the API rejects with 400, renders the not-found page
 * - any other failure (5xx, success:false, no response) throws to the admin
 *   error boundary instead of reading as a missing user (#518)
 * - no session → not-found, without fetching
 * - happy path → the user, with real `Date`s, reaches the form
 *
 * Only `serverFetch` is faked: the real parser and `lib/api/server-load.ts` run.
 *
 * @see app/admin/users/[id]/edit/page.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  unstable_rethrow: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

// Only the network is faked: the real parseApiResponse and server-load run.
vi.mock('@/lib/api/server-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/server-fetch')>()),
  serverFetch: vi.fn(),
}));

vi.mock('@/lib/logging', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth/utils', () => ({
  getServerSession: vi.fn(),
}));

const formProps = vi.fn();
vi.mock('@/components/admin/user-edit-form', () => ({
  UserEditForm: (props: unknown) => {
    formProps(props);
    return <div data-testid="user-edit-form" />;
  },
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import AdminUserEditPage from '@/app/admin/users/[id]/edit/page';
import { notFound } from 'next/navigation';
import { serverFetch } from '@/lib/api/server-fetch';
import { ServerLoadError } from '@/lib/api/server-load';
import { getServerSession } from '@/lib/auth/utils';
import { logger } from '@/lib/logging';
import { apiFailure, apiSuccess, apiIdRejected } from '@/tests/helpers/api';
import { createMockSession } from '@/tests/types/mocks';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const USER = {
  id: 'user-123',
  name: 'John Doe',
  email: 'john@example.com',
  emailVerified: true,
  image: null,
  role: 'USER',
  bio: null,
  phone: null,
  timezone: null,
  location: null,
  createdAt: '2024-01-15T00:00:00.000Z',
  updatedAt: '2024-02-20T00:00:00.000Z',
};

const params = Promise.resolve({ id: 'user-123' });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AdminUserEditPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getServerSession).mockResolvedValue(
      createMockSession({ user: { id: 'admin-id', email: 'admin@example.com', role: 'ADMIN' } })
    );
  });

  it('hands the user, with real dates, and the current user id to the form', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiSuccess(USER));

    render(await AdminUserEditPage({ params }));

    expect(vi.mocked(serverFetch).mock.calls[0][0]).toBe('/api/v1/users/user-123');
    expect(screen.getByTestId('user-edit-form')).toBeInTheDocument();
    expect(formProps).toHaveBeenCalledWith({
      user: {
        ...USER,
        createdAt: new Date(USER.createdAt),
        updatedAt: new Date(USER.updatedAt),
      },
      currentUserId: 'admin-id',
    });
  });

  it('is not found, without fetching, when there is no session', async () => {
    vi.mocked(getServerSession).mockResolvedValue(null);

    await expect(AdminUserEditPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(serverFetch).not.toHaveBeenCalled();
  });

  it('is not found when the user does not exist', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(404, 'NOT_FOUND'));

    await expect(AdminUserEditPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFound).toHaveBeenCalledOnce();
  });

  it('is not found when the API rejects the id as malformed (400)', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiIdRejected('query'));

    await expect(AdminUserEditPage({ params })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  // ── A failed load is a failure, not a missing user (#518) ───────────────

  it('throws to the error boundary, not notFound(), when the API answers 500', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(500));

    await expect(AdminUserEditPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('throws to the error boundary when the API answers success: false', async () => {
    vi.mocked(serverFetch).mockResolvedValue(apiFailure(200));

    await expect(AdminUserEditPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
  });

  it('throws to the error boundary, and logs, when the fetch rejects', async () => {
    const failure = new Error('ECONNREFUSED');
    vi.mocked(serverFetch).mockRejectedValue(failure);

    await expect(AdminUserEditPage({ params })).rejects.toBeInstanceOf(ServerLoadError);
    expect(notFound).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.any(String), failure, expect.any(Object));
  });
});
