/**
 * Tests: PATCH / DELETE /api/v1/admin/waitlist/:id (§125 t-976)
 *
 * Remove is PATCH with the state to reach; erase is DELETE through
 * `eraseWaitlistEntry()`. Neither logs nor audits the address.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { DEFAULT_WAITLIST_RETENTION, type ResolvedWaitlistConfig } from '@/lib/waitlist/config';

const { mockConfig, mockSetRemoved, mockErase, mockAudit, mockLog } = vi.hoisted(() => {
  const mockConfig: { current: ResolvedWaitlistConfig | null } = { current: null };
  return {
    mockConfig,
    mockSetRemoved: vi.fn(),
    mockErase: vi.fn(),
    mockAudit: vi.fn(),
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));
vi.mock('@/lib/waitlist/admin', () => ({ setWaitlistEntryRemoved: mockSetRemoved }));
vi.mock('@/lib/waitlist/erase', () => ({ eraseWaitlistEntry: mockErase }));
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({ logAdminAction: mockAudit }));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn().mockResolvedValue(mockLog) }));

import { auth } from '@/lib/auth/config';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { DELETE, PATCH } from '@/app/api/v1/admin/waitlist/[id]/route';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
};
const ID = 'cmw0s7r0x000q08le5j01nd17';
const ENTRY = { id: ID, email: 'ada@example.com', name: 'Ada', list: 'default', removedAt: null };
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

function patch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost:3000/api/v1/admin/waitlist/${ID}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}
const del = () =>
  new NextRequest(`http://localhost:3000/api/v1/admin/waitlist/${ID}`, { method: 'DELETE' });

/** Everything this route wrote to the logs and the audit trail, as one string. */
function everythingLogged(): string {
  return JSON.stringify([mockAudit.mock.calls, mockLog.info.mock.calls, mockLog.warn.mock.calls]);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = CONFIG;
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockSetRemoved.mockResolvedValue(ENTRY);
  mockErase.mockResolvedValue({
    receiptId: 'r-1',
    erasedAt: new Date('2026-11-04T10:00:00Z'),
    invitationsDeleted: 1,
  });
});

describe('PATCH /api/v1/admin/waitlist/:id', () => {
  it.each([true, false])('sets removed: %s, the state to reach', async (removed) => {
    const response = await PATCH(patch({ removed }), ctx());

    expect(response.status).toBe(200);
    expect(mockSetRemoved).toHaveBeenCalledWith(ID, removed);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: removed ? 'waitlist_entry.remove' : 'waitlist_entry.restore',
        entityType: 'waitlist_entry',
        entityId: ID,
        entityName: 'default',
      })
    );
  });

  it('answers 404 for an entry this org does not have', async () => {
    mockSetRemoved.mockResolvedValue(null);

    expect((await PATCH(patch({ removed: true }), ctx())).status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['no removed', {}],
    ['a removed that is not a boolean', { removed: 'yes' }],
    ['a key it does not take', { removed: true, email: 'x@example.com' }],
  ])('refuses %s with a 400', async (_label, body) => {
    expect((await PATCH(patch(body), ctx())).status).toBe(400);
    expect(mockSetRemoved).not.toHaveBeenCalled();
  });

  it('refuses a malformed id before reading anything', async () => {
    expect((await PATCH(patch({ removed: true }), ctx('not-a-cuid'))).status).toBe(400);
    expect(mockSetRemoved).not.toHaveBeenCalled();
  });

  it('answers 404 while the app has no waitlist, and 403 to a non-admin', async () => {
    mockConfig.current = null;
    expect((await PATCH(patch({ removed: true }), ctx())).status).toBe(404);

    mockConfig.current = CONFIG;
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await PATCH(patch({ removed: true }), ctx())).status).toBe(403);
    expect(mockSetRemoved).not.toHaveBeenCalled();
  });

  it('logs and audits neither the address nor the name', async () => {
    await PATCH(patch({ removed: true }), ctx());

    expect(everythingLogged()).not.toContain('ada@example.com');
    expect(everythingLogged()).not.toContain('Ada');
  });
});

describe('DELETE /api/v1/admin/waitlist/:id', () => {
  it('erases through the waitlist writer as the admin, and says what it did', async () => {
    const response = await DELETE(del(), ctx());
    const body = (await response.json()) as { data: unknown };

    expect(response.status).toBe(200);
    expect(mockErase).toHaveBeenCalledWith({
      entryId: ID,
      actorUserId: mockAdminUser().user.id,
      reason: 'admin_action',
    });
    expect(body.data).toEqual({
      erased: true,
      receiptId: 'r-1',
      erasedAt: '2026-11-04T10:00:00.000Z',
      invitationsDeleted: 1,
    });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'waitlist_entry.erase', entityId: ID, entityName: null })
    );
  });

  it('answers 404 for an entry already erased: the verb never claims a deletion that did not happen', async () => {
    mockErase.mockResolvedValue(null);

    expect((await DELETE(del(), ctx())).status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('answers 404 while the app has no waitlist, without erasing', async () => {
    mockConfig.current = null;

    expect((await DELETE(del(), ctx())).status).toBe(404);
    expect(mockErase).not.toHaveBeenCalled();
  });
});
