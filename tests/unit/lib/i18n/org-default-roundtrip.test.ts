/**
 * An org admin's language choice reaches the org's members (§138 t-1074).
 *
 * The Options page saves through `PUT /api/v1/orgs/[id]/locale`, which writes
 * with `writeOrgLocale()`. This runs that real write and then the real
 * request resolution over one org row, so what the admin stores is exactly
 * what a member's next request reads: a member with no language of their own
 * gets the org's, one with a choice keeps theirs, and clearing the org's
 * leaves members to their browser.
 *
 * The page's picker and the route each have their own tests
 * (`org-language-form.test.tsx`, `app/api/v1/orgs/[id]/locale/route.test.ts`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockPrincipal = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/admin-page-viewer', () => ({ requestPrincipal: mockPrincipal }));

/** One org row and one member, shared by the write and the read. */
const store = vi.hoisted(() => ({
  orgSettings: null,
  memberLocale: null as string | null,
}));
const mockPrisma = vi.hoisted(() => {
  const db = {
    org: {
      findUnique: vi.fn(async () => ({ settings: store.orgSettings })),
      update: vi.fn(async ({ data }: { data: { settings: unknown } }) => {
        store.orgSettings = data.settings;
        return { settings: store.orgSettings };
      }),
    },
    user: {
      findUnique: vi.fn(async () => ({ locale: store.memberLocale, timezone: 'UTC' })),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return db;
});
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const browser = vi.hoisted(() => ({ acceptLanguage: null as string | null }));
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: vi.fn(async () => {
    const h = new Headers();
    if (browser.acceptLanguage) h.set('accept-language', browser.acceptLanguage);
    return h;
  }),
}));
vi.mock('next-intl/server', () => ({ getRequestConfig: (fn: unknown) => fn }));

import { writeOrgLocale } from '@/lib/tenancy/org-settings';
import { requestLocale } from '@/lib/i18n/request';

const ORG = 'cmorg000000000000000acme1';
const MEMBER = 'cmuser0000000000000000usr1';

beforeEach(() => {
  vi.clearAllMocks();
  // A fork's own key in the column, which the write must keep.
  store.orgSettings = { forkThing: { on: true } };
  store.memberLocale = null;
  browser.acceptLanguage = 'en-GB';
  mockPrincipal.mockResolvedValue({ principal: { userId: MEMBER, orgId: ORG } });
});

describe('an org default set on Options', () => {
  it('is the language a member with no choice of their own sees', async () => {
    expect(await requestLocale()).toMatchObject({ locale: 'en', source: 'accept-language' });

    await writeOrgLocale(ORG, 'en-XA');

    expect(store.orgSettings).toEqual({ forkThing: { on: true }, locale: 'en-XA' });
    expect(await requestLocale()).toMatchObject({ locale: 'en-XA', source: 'org' });
  });

  it("does not override a member's own choice", async () => {
    store.memberLocale = 'en';
    await writeOrgLocale(ORG, 'en-XA');

    expect(await requestLocale()).toMatchObject({ locale: 'en', source: 'user' });
  });

  it("leaves members to their browser's language once cleared", async () => {
    await writeOrgLocale(ORG, 'en-XA');
    await writeOrgLocale(ORG, null);

    expect(store.orgSettings).toEqual({ forkThing: { on: true } });
    expect(await requestLocale()).toMatchObject({ locale: 'en', source: 'accept-language' });
  });
});
