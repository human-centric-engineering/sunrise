/**
 * Tests: PATCH /api/v1/admin/waitlist/lists/:key (§125 t-976)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const { mockConfig, mockSetOpen, mockAudit } = vi.hoisted(() => ({
  mockConfig: { current: null },
  mockSetOpen: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));
vi.mock('@/lib/waitlist/admin', () => ({ setWaitlistListOpen: mockSetOpen }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));

import { auth } from '@/lib/auth/config';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { PATCH } from '@/app/api/v1/admin/waitlist/lists/[key]/route';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [],
  lists: [{ key: 'default' }, { key: 'beta' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};
const CHANGED_AT = new Date('2026-11-04T10:00:00Z');

function patch(key: string, body: unknown) {
  return [
    new NextRequest(`http://localhost:3000/api/v1/admin/waitlist/lists/${key}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ key }) },
  ] as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = CONFIG;
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockSetOpen.mockImplementation(async (key: string, open: boolean) => ({
    key,
    open,
    changedAt: CHANGED_AT,
  }));
});

describe('PATCH /api/v1/admin/waitlist/lists/:key', () => {
  it.each([false, true])('sets open: %s for a declared list, as the admin', async (open) => {
    const response = await PATCH(...patch('beta', { open }));
    const body = (await response.json()) as { data: unknown };

    expect(response.status).toBe(200);
    expect(mockSetOpen).toHaveBeenCalledWith('beta', open, mockAdminUser().user.id);
    expect(body.data).toEqual({ key: 'beta', open, changedAt: CHANGED_AT.toISOString() });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: open ? 'waitlist_list.open' : 'waitlist_list.close',
        entityType: 'waitlist_list',
        entityId: 'beta',
      })
    );
  });

  it.each([
    ['a list the config does not declare', 'retired'],
    ['a key no list could have', 'no%20spaces'],
  ])('answers 404 for %s, writing nothing', async (_label, key) => {
    expect((await PATCH(...patch(key, { open: false }))).status).toBe(404);
    expect(mockSetOpen).not.toHaveBeenCalled();
  });

  it('refuses a body without a boolean open', async () => {
    expect((await PATCH(...patch('beta', { open: 'no' }))).status).toBe(400);
    expect((await PATCH(...patch('beta', {}))).status).toBe(400);
    expect(mockSetOpen).not.toHaveBeenCalled();
  });

  it('answers 404 while the app has no waitlist, and 403 to a non-admin', async () => {
    mockConfig.current = null;
    expect((await PATCH(...patch('beta', { open: false }))).status).toBe(404);

    mockConfig.current = CONFIG;
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await PATCH(...patch('beta', { open: false }))).status).toBe(403);
    expect(mockSetOpen).not.toHaveBeenCalled();
  });
});
