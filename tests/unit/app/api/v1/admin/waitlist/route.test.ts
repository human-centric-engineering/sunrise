/**
 * Tests: GET /api/v1/admin/waitlist (§125 t-976)
 *
 * The guard, the 404 while the app has no waitlist, the query's validation and
 * its defaults, and the paginated answer. What the query does to the database
 * is `tests/unit/lib/waitlist/admin.test.ts`'s.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const { mockConfig, mockList } = vi.hoisted(() => {
  const mockConfig: { current: ResolvedWaitlistConfig | null } = { current: null };
  return {
    mockConfig,
    mockList: vi.fn(),
  };
});

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));
vi.mock('@/lib/waitlist/admin', () => ({ listWaitlistEntries: mockList }));

import { auth } from '@/lib/auth/config';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';
import { GET } from '@/app/api/v1/admin/waitlist/route';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};

function get(query = ''): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/waitlist${query}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = CONFIG;
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockList.mockResolvedValue({ entries: [], total: 0 });
});

describe('GET /api/v1/admin/waitlist', () => {
  it('refuses an anonymous caller and a non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    expect((await GET(get())).status).toBe(401);

    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await GET(get())).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('answers 404 while the app has no waitlist', async () => {
    mockConfig.current = null;

    const response = await GET(get());

    expect(response.status).toBe(404);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('asks for confirmed entries, newest first, 25 to a page, by default', async () => {
    await GET(get());

    expect(mockList).toHaveBeenCalledWith(CONFIG, {
      page: 1,
      limit: 25,
      sortBy: 'createdAt',
      sortOrder: 'desc',
    });
  });

  it('passes the filters, reading "false" as false', async () => {
    await GET(
      get(
        '?page=2&limit=50&sortBy=email&sortOrder=asc&list=beta&q=ada&includeUnconfirmed=true&includeRemoved=false&flaggedOnly=true'
      )
    );

    expect(mockList).toHaveBeenCalledWith(CONFIG, {
      page: 2,
      limit: 50,
      sortBy: 'email',
      sortOrder: 'asc',
      list: 'beta',
      q: 'ada',
      includeUnconfirmed: true,
      includeRemoved: false,
      flaggedOnly: true,
    });
  });

  it.each([
    ['a sort field it does not offer', '?sortBy=name'],
    ['a page over 100 rows', '?limit=101'],
    ['a malformed list key', '?list=no%20spaces'],
  ])('refuses %s with a 400', async (_label, query) => {
    expect((await GET(get(query))).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it('answers the page with its pagination meta', async () => {
    mockList.mockResolvedValue({ entries: [{ id: 'e1' }, { id: 'e2' }], total: 51 });

    const response = await GET(get('?page=2'));
    const body = (await response.json()) as { data: unknown; meta: unknown };

    expect(response.status).toBe(200);
    expect(body.data).toEqual([{ id: 'e1' }, { id: 'e2' }]);
    expect(body.meta).toEqual({ page: 2, limit: 25, total: 51, totalPages: 3 });
  });
});
