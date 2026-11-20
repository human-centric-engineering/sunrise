/**
 * The request config's inputs (§138 t-1071): the signed-in user's choice and
 * time zone, the acting org's default, the cookie and Accept-Language reach
 * the resolution, and a failed preferences read degrades to the browser's
 * language rather than failing the page.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrincipal = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestPrincipal: mockPrincipal }));

const mockPrisma = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  org: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLog }));

const request = vi.hoisted(() => ({
  cookie: null as string | null,
  acceptLanguage: null as string | null,
}));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === 'sunrise_locale' && request.cookie ? { value: request.cookie } : undefined,
  })),
  headers: vi.fn(async () => {
    const h = new Headers();
    if (request.acceptLanguage) h.set('accept-language', request.acceptLanguage);
    return h;
  }),
}));

import { requestLocale } from '@/lib/i18n/request';

const USER = 'cmuser0000000000000000usr1';
const ORG = 'cmorg000000000000000acme1';

function signedIn(orgId: string | null = ORG) {
  mockPrincipal.mockResolvedValue({ principal: { userId: USER, orgId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  request.cookie = null;
  request.acceptLanguage = null;
  mockPrincipal.mockResolvedValue(null);
  mockPrisma.user.findUnique.mockResolvedValue({ locale: null, timezone: 'UTC' });
  mockPrisma.org.findUnique.mockResolvedValue({ settings: null });
});

describe('requestLocale', () => {
  it('serves a visitor from the cookie, then the browser', async () => {
    request.acceptLanguage = 'en-GB';
    expect(await requestLocale()).toMatchObject({ locale: 'en', source: 'accept-language' });

    request.cookie = 'en-XA';
    expect(await requestLocale()).toMatchObject({ locale: 'en-XA', source: 'cookie' });
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — no session, no lookup;
  });

  it('serves a signed-in user their own choice and time zone', async () => {
    signedIn();
    mockPrisma.user.findUnique.mockResolvedValue({ locale: 'en-XA', timezone: 'Asia/Tokyo' });

    expect(await requestLocale()).toEqual({
      locale: 'en-XA',
      source: 'user',
      timeZone: 'Asia/Tokyo',
    });
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER },
      select: { locale: true, timezone: true },
    });
  });

  it('serves the acting org’s default to a user with no choice of their own', async () => {
    signedIn();
    request.cookie = 'en';
    mockPrisma.org.findUnique.mockResolvedValue({ settings: { locale: 'en-XA' } });

    expect(await requestLocale()).toMatchObject({ locale: 'en-XA', source: 'org' });
    expect(mockPrisma.org.findUnique).toHaveBeenCalledWith({
      where: { id: ORG },
      select: { settings: true },
    });
  });

  it('reads no org for a user acting in none', async () => {
    signedIn(null);
    request.cookie = 'en-XA';

    expect(await requestLocale()).toMatchObject({ locale: 'en-XA', source: 'cookie' });
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled(); // test-review:accept no_arg_called — no org to read;
  });

  it('replaces a time zone Intl does not know with UTC', async () => {
    signedIn();
    mockPrisma.user.findUnique.mockResolvedValue({ locale: null, timezone: 'Mars/Olympus' });
    expect((await requestLocale()).timeZone).toBe('UTC');
  });

  it('degrades to the browser’s language, with a warning, when the preferences cannot be read', async () => {
    signedIn();
    request.cookie = 'en-XA';
    mockPrisma.user.findUnique.mockRejectedValue(new Error('connection refused'));

    expect(await requestLocale()).toEqual({ locale: 'en-XA', source: 'cookie', timeZone: 'UTC' });
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not read the viewer'),
      { error: 'connection refused' }
    );
  });
});
