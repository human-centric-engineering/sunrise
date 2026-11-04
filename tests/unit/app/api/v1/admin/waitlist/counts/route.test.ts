/**
 * Tests: GET /api/v1/admin/waitlist/counts (§125 t-976)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const { mockConfig, mockCount } = vi.hoisted(() => ({
  mockConfig: { current: null },
  mockCount: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));
vi.mock('@/lib/waitlist/admin', () => ({ countWaitlistEntries: mockCount }));

import { auth } from '@/lib/auth/config';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/waitlist/counts/route';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [
    {
      key: 'role',
      label: 'Role',
      kind: 'select',
      options: [{ value: 'dj', label: 'DJ' }],
      // Something a fork attached that is not the form's to know.
      ...({ internal: () => 1 } as object),
    },
  ],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};

const request = () => new NextRequest('http://localhost:3000/api/v1/admin/waitlist/counts');

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = CONFIG;
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockCount.mockResolvedValue([{ key: 'default', open: true, confirmed: 3 }]);
});

describe('GET /api/v1/admin/waitlist/counts', () => {
  it('refuses a non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

    expect((await GET(request())).status).toBe(403);
    expect(mockCount).not.toHaveBeenCalled();
  });

  it('answers 404 while the app has no waitlist', async () => {
    mockConfig.current = null;

    expect((await GET(request())).status).toBe(404);
  });

  it('answers each list’s counts and the declared fields, serialisable', async () => {
    const response = await GET(request());
    const body = (await response.json()) as { data: unknown };

    expect(body.data).toEqual({
      lists: [{ key: 'default', open: true, confirmed: 3 }],
      fields: [
        { key: 'role', label: 'Role', kind: 'select', options: [{ value: 'dj', label: 'DJ' }] },
      ],
    });
    expect(mockCount).toHaveBeenCalledWith(CONFIG);
  });
});
