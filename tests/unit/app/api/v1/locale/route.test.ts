/**
 * Unit Tests: PUT /api/v1/locale (§138 t-1071) — a visitor's own language,
 * kept in a cookie.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const cookieStore = vi.hoisted(() => ({ set: vi.fn(), delete: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => cookieStore) }));

import { PUT } from '@/app/api/v1/locale/route';
import { LOCALE_COOKIE_MAX_AGE, LOCALE_COOKIE_NAME } from '@/lib/i18n/locales';

const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/v1/locale', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );

beforeEach(() => vi.clearAllMocks());

describe('PUT /api/v1/locale', () => {
  it('keeps a supported locale in the cookie, canonicalised', async () => {
    const res = await put({ locale: 'EN-xa' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { locale: 'en-XA' } });
    expect(cookieStore.set).toHaveBeenCalledWith(
      LOCALE_COOKIE_NAME,
      'en-XA',
      expect.objectContaining({
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: 'lax',
        httpOnly: true,
      })
    );
  });

  it('clears the cookie with null', async () => {
    expect((await put({ locale: null })).status).toBe(200);
    expect(cookieStore.delete).toHaveBeenCalledWith(LOCALE_COOKIE_NAME);
    expect(cookieStore.set).not.toHaveBeenCalled(); // test-review:accept no_arg_called — clearing sets nothing;
  });

  it('refuses a locale with no catalogue, setting nothing', async () => {
    const res = await put({ locale: 'fr' });
    expect(res.status).toBe(400);
    expect(cookieStore.set).not.toHaveBeenCalled(); // test-review:accept no_arg_called — refused by validation;
  });

  it('refuses a body with other keys', async () => {
    expect((await put({ locale: 'en', extra: 1 })).status).toBe(400);
  });
});
