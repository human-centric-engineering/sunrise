/**
 * Tests: GET /api/v1/admin/waitlist/export (§125 t-976)
 *
 * The spec's export rules (*Rules carried over*): a route of its own, its own
 * limiter key, a UTF-8 BOM, `no-store`, a row cap the filename states, and
 * logs that carry counts only. Plus: every cell is formula-neutralised.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  DEFAULT_WAITLIST_JOIN_PATH,
  DEFAULT_WAITLIST_RETENTION,
  type ResolvedWaitlistConfig,
} from '@/lib/waitlist/config';
import { WAITLIST_EXPORT_MAX_ROWS } from '@/lib/validations/waitlist';

const { mockConfig, mockPrisma, mockCheck, mockLog } = vi.hoisted(() => {
  const mockConfig: { current: ResolvedWaitlistConfig | null } = { current: null };
  return {
    mockConfig,
    mockPrisma: { waitlistEntry: { findMany: vi.fn(), count: vi.fn() } },
    mockCheck: vi.fn(),
    mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@/lib/auth/config', () => ({ auth: { api: { getSession: vi.fn() } } }));
vi.mock('next/headers', () => ({ headers: vi.fn(() => Promise.resolve(new Headers())) }));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/waitlist/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/waitlist/config')>()),
  getWaitlistConfig: () => mockConfig.current,
}));
vi.mock('@/lib/security/rate-limit', () => ({
  exportLimiter: { check: mockCheck },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));
vi.mock('@/lib/api/context', () => ({ getRouteLogger: vi.fn().mockResolvedValue(mockLog) }));

import { auth } from '@/lib/auth/config';
import { mockAdminUser, mockAuthenticatedUser } from '@/tests/helpers/auth';
import { parseCsvRecords } from '@/tests/helpers/csv';
import { GET } from '@/app/api/v1/admin/waitlist/export/route';

const CONFIG: ResolvedWaitlistConfig = {
  consentVersion: 'v1',
  fields: [
    { key: 'role', label: 'Role', kind: 'select', options: [{ value: 'dj', label: 'DJ' }] },
    { key: 'useCase', label: 'Use case', kind: 'textarea' },
  ],
  lists: [{ key: 'default' }],
  screen: null,
  retention: DEFAULT_WAITLIST_RETENTION,
  joinPath: DEFAULT_WAITLIST_JOIN_PATH,
};

const T = new Date('2026-11-01T09:00:00Z');
function row(over: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    email: 'ada@example.com',
    name: 'Ada',
    list: 'default',
    details: { role: 'dj', useCase: 'Sets', retired: 'gone' },
    source: 'form',
    locale: 'en-GB',
    utmSource: 'instagram',
    utmMedium: null,
    utmCampaign: null,
    referrerHost: 'example.org',
    consentedAt: T,
    consentVersion: 'v1',
    flaggedReason: null,
    confirmedAt: T,
    removedAt: null,
    rejoinRequestedAt: null,
    rejoinRequests: 0,
    invitedAt: null,
    joinedAt: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

const get = (query = '') =>
  new NextRequest(`http://localhost:3000/api/v1/admin/waitlist/export${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfig.current = CONFIG;
  vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
  mockCheck.mockReturnValue({ success: true, limit: 10, remaining: 9, reset: 0 });
  mockPrisma.waitlistEntry.findMany.mockResolvedValue([row()]);
  mockPrisma.waitlistEntry.count.mockResolvedValue(1);
});

describe('GET /api/v1/admin/waitlist/export', () => {
  it('answers a BOM-prefixed CSV, never cached, with one column per declared answer', async () => {
    const response = await GET(get());
    // The bytes, not text(): decoding strips a leading BOM.
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const [header, first] = parseCsvRecords(text.slice(1));
    expect(header[0]).toBe('id');
    expect(header.slice(-2)).toEqual(['role', 'useCase']);
    expect(first[header.indexOf('email')]).toBe('ada@example.com');
    expect(first[header.indexOf('role')]).toBe('dj');
    expect(first[header.indexOf('utm_source')]).toBe('instagram');
    expect(first[header.indexOf('confirmed_at')]).toBe(T.toISOString());
    // An answer the config no longer declares is not exported.
    expect(text).not.toContain('gone');
  });

  it('neutralises a cell a stranger typed as a formula', async () => {
    mockPrisma.waitlistEntry.findMany.mockResolvedValue([
      row({ name: '=HYPERLINK("http://evil")', details: { useCase: '+1-2' } }),
    ]);

    // text() has already dropped the BOM.
    const text = await (await GET(get())).text();
    const [header, first] = parseCsvRecords(text);

    expect(first[header.indexOf('name')]).toBe(`'=HYPERLINK("http://evil")`);
    expect(first[header.indexOf('useCase')]).toBe(`'+1-2`);
  });

  it('names the file by list and date, and says so when the row cap bit', async () => {
    mockPrisma.waitlistEntry.count.mockResolvedValue(WAITLIST_EXPORT_MAX_ROWS + 5);

    const response = await GET(get('?list=default'));

    expect(response.headers.get('Content-Disposition')).toMatch(
      new RegExp(
        `^attachment; filename="waitlist-default-\\d{4}-\\d{2}-\\d{2}-first-1-of-${WAITLIST_EXPORT_MAX_ROWS + 5}\\.csv"$`
      )
    );
    const [args] = mockPrisma.waitlistEntry.findMany.mock.calls[0] as [
      { take: number; orderBy: unknown },
    ];
    expect(args.take).toBe(WAITLIST_EXPORT_MAX_ROWS);
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });

  it('names an uncapped export without a cap', async () => {
    const response = await GET(get());

    expect(response.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="waitlist-all-\d{4}-\d{2}-\d{2}\.csv"$/
    );
  });

  it('uses its own limiter key, and answers 429 without reading when spent', async () => {
    mockCheck.mockReturnValue({ success: false, limit: 10, remaining: 0, reset: 0 });

    const response = await GET(get());

    expect(mockCheck).toHaveBeenCalledWith(`export:waitlist:user:${mockAdminUser().user.id}`);
    expect(response.status).toBe(429);
    expect(mockPrisma.waitlistEntry.findMany).not.toHaveBeenCalled();
  });

  it('logs counts only — no address, name or answer', async () => {
    await GET(get());

    expect(mockLog.info).toHaveBeenCalledWith('Waitlist export', {
      list: 'all',
      rows: 1,
      total: 1,
      capped: false,
    });
    const logged = JSON.stringify(mockLog.info.mock.calls);
    expect(logged).not.toContain('ada@example.com');
    expect(logged).not.toContain('Sets');
  });

  it('applies the list page’s filters: confirmed only by default', async () => {
    await GET(get('?includeUnconfirmed=true'));
    const [withUnconfirmed] = mockPrisma.waitlistEntry.findMany.mock.calls[0] as [
      { where: { AND: unknown[] } },
    ];
    expect(withUnconfirmed.where.AND).not.toContainEqual({ confirmedAt: { not: null } });

    await GET(get());
    const [byDefault] = mockPrisma.waitlistEntry.findMany.mock.calls[1] as [
      { where: { AND: unknown[] } },
    ];
    expect(byDefault.where.AND).toContainEqual({ confirmedAt: { not: null } });
  });

  it('answers 404 while the app has no waitlist, and 403 to a non-admin', async () => {
    mockConfig.current = null;
    expect((await GET(get())).status).toBe(404);

    mockConfig.current = CONFIG;
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    expect((await GET(get())).status).toBe(403);
    expect(mockPrisma.waitlistEntry.findMany).not.toHaveBeenCalled();
  });
});
