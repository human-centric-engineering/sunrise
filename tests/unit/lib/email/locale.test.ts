/**
 * Which language an email goes out in (§138 t-1075): `lib/email/locale.ts`.
 *
 * Prisma is mocked; the resolution, the catalogue and the supported-locale
 * list are real. The pseudo-locale (`en-XA`) stands in for "a language other
 * than English" where the platform alone is under test, and `fr`, registered
 * the way an app registers a language, where the app seam is.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@react-email/render';

const { mockPrisma, mockLogger, appInit } = vi.hoisted(() => ({
  mockPrisma: {
    user: { findUnique: vi.fn() },
    org: { findUnique: vi.fn() },
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  appInit: { run: (): void => {} },
}));
vi.mock('@/lib/db/client', () => ({ prisma: mockPrisma }));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));
vi.mock('@/lib/app/messages', () => ({ initAppMessages: () => appInit.run() }));

import {
  DEFAULT_EMAIL_LOCALE,
  emailLocaleForAddress,
  emailLocaleForOrg,
  emailLocaleForUser,
  emailLocaleFrom,
} from '@/lib/email/locale';
import { emailTranslator } from '@/lib/email/translate';
import { resolveEmailTemplate } from '@/lib/email/registry';
import {
  __resetAppMessagesForTests,
  registerAppLocale,
  registerAppMessages,
} from '@/lib/i18n/registry';

const PSEUDO = 'en-XA';

/** An org row whose default is `locale` (or none). */
function orgWith(locale: string | null) {
  return { settings: locale ? { locale } : {} };
}

/** A user row as `emailLocaleForUser` reads it. */
function userRow(overrides: Record<string, unknown> = {}) {
  return {
    locale: null,
    timezone: 'Europe/London',
    signupOrgId: null,
    orgMemberships: [] as Array<{ orgId: string; org: { status: string } }>,
    ...overrides,
  };
}

/** Each org's default, as `org.findUnique` answers it; filled by {@link member}. */
const orgLocales = new Map<string, string | null>();

/** A membership row, and its org's default for `org.findUnique` to answer. */
function member(orgId: string, locale: string | null, status = 'ACTIVE') {
  orgLocales.set(orgId, locale);
  return { orgId, org: { status } };
}

beforeEach(() => {
  vi.clearAllMocks();
  appInit.run = () => {};
  __resetAppMessagesForTests();
  orgLocales.clear();
  mockPrisma.org.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    Promise.resolve(orgLocales.has(where.id) ? orgWith(orgLocales.get(where.id) ?? null) : null)
  );
});

describe('emailLocaleFrom', () => {
  it('takes the user’s own choice over the org’s', () => {
    expect(emailLocaleFrom({ userLocale: PSEUDO, orgLocale: 'en' })).toEqual({
      locale: PSEUDO,
      timeZone: 'UTC',
    });
  });

  it('falls back to the org’s default, then English', () => {
    expect(emailLocaleFrom({ orgLocale: PSEUDO }).locale).toBe(PSEUDO);
    expect(emailLocaleFrom({})).toEqual(DEFAULT_EMAIL_LOCALE);
  });

  it('skips a stored tag with no catalogue', () => {
    expect(emailLocaleFrom({ userLocale: 'fr', orgLocale: PSEUDO }).locale).toBe(PSEUDO);
  });

  it('keeps a zone Intl knows and replaces one it does not', () => {
    expect(emailLocaleFrom({ timeZone: 'America/New_York' }).timeZone).toBe('America/New_York');
    expect(emailLocaleFrom({ timeZone: 'Mars/Olympus' }).timeZone).toBe('UTC');
  });
});

describe('emailLocaleForUser', () => {
  it('uses the user’s own language and time zone', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      userRow({ locale: PSEUDO, orgMemberships: [member('org-a', 'en')] })
    );

    expect(await emailLocaleForUser('u1')).toEqual({ locale: PSEUDO, timeZone: 'Europe/London' });
  });

  it('falls back to the default of the org they belong to', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      userRow({ orgMemberships: [member('org-a', PSEUDO)] })
    );

    expect((await emailLocaleForUser('u1')).locale).toBe(PSEUDO);
    // The memberships carry no settings: only the chosen org's are read.
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          orgMemberships: expect.objectContaining({
            select: { orgId: true, org: { select: { status: true } } },
          }),
        }),
      })
    );
    expect(mockPrisma.org.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma.org.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-a' } })
    );
  });

  it('reads the org a sign-in would start them in: an active one over a suspended one', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      userRow({
        orgMemberships: [member('org-suspended', 'en', 'SUSPENDED'), member('org-active', PSEUDO)],
      })
    );

    expect((await emailLocaleForUser('u1')).locale).toBe(PSEUDO);
  });

  it('reads the org their signup recorded when the membership is not written yet', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(userRow({ signupOrgId: 'org-signup' }));
    mockPrisma.org.findUnique.mockResolvedValue(orgWith(PSEUDO));

    expect((await emailLocaleForUser('u1')).locale).toBe(PSEUDO);
    expect(mockPrisma.org.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-signup' } })
    );
  });

  it('reads the org the send names, ahead of their usual one', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      userRow({ orgMemberships: [member('org-home', 'en')] })
    );
    mockPrisma.org.findUnique.mockResolvedValue(orgWith(PSEUDO));

    expect((await emailLocaleForUser('u1', { orgId: 'org-inviting' })).locale).toBe(PSEUDO);
  });

  it('writes in English when there is no such user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    expect(await emailLocaleForUser('gone')).toEqual(DEFAULT_EMAIL_LOCALE);
  });

  it('writes in English, and says so, when the read fails', async () => {
    mockPrisma.user.findUnique.mockRejectedValue(new Error('db down'));

    expect(await emailLocaleForUser('u1')).toEqual(DEFAULT_EMAIL_LOCALE);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('writing in English'),
      expect.objectContaining({ userId: 'u1', error: 'db down' })
    );
  });
});

describe('emailLocaleForOrg', () => {
  it('uses the org’s default, in UTC', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(orgWith(PSEUDO));
    expect(await emailLocaleForOrg('org-a')).toEqual({ locale: PSEUDO, timeZone: 'UTC' });
  });

  it('puts a tag the send site holds (a waitlist entry’s) ahead of the org’s default', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(orgWith('en'));
    expect((await emailLocaleForOrg('org-a', { locale: PSEUDO })).locale).toBe(PSEUDO);
  });

  it('serves a regional tag by its base language', async () => {
    mockPrisma.org.findUnique.mockResolvedValue(orgWith(PSEUDO));
    // `en-GB` is served by `en`, ahead of the org's pseudo default.
    expect((await emailLocaleForOrg('org-a', { locale: 'en-GB' })).locale).toBe('en');
  });

  it('writes in English with no org, and reads nothing', async () => {
    expect(await emailLocaleForOrg(null)).toEqual(DEFAULT_EMAIL_LOCALE);
    expect(mockPrisma.org.findUnique).not.toHaveBeenCalled();
  });

  it('keeps the held tag when the org read fails', async () => {
    mockPrisma.org.findUnique.mockRejectedValue(new Error('db down'));
    expect((await emailLocaleForOrg('org-a', { locale: PSEUDO })).locale).toBe(PSEUDO);
    expect(mockLogger.warn).toHaveBeenCalled();
  });
});

describe('emailLocaleForAddress', () => {
  it('uses the account’s own choice when the address has one', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({ id: 'u1' })
      .mockResolvedValueOnce(userRow({ locale: PSEUDO }));

    expect((await emailLocaleForAddress('Jane@Example.com', 'org-a')).locale).toBe(PSEUDO);
    expect(mockPrisma.user.findUnique).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { email: 'jane@example.com' } })
    );
  });

  it('uses the org’s default when the address has no account', async () => {
    mockPrisma.user.findUnique.mockResolvedValueOnce(null);
    mockPrisma.org.findUnique.mockResolvedValue(orgWith(PSEUDO));

    expect((await emailLocaleForAddress('new@example.com', 'org-a')).locale).toBe(PSEUDO);
  });
});

describe('a language an app registers', () => {
  beforeEach(() => {
    appInit.run = () => {
      registerAppLocale('fr', {
        emails: { welcome: { heading: 'Bienvenue sur {brand} !', subject: 'Bienvenue' } },
      });
      registerAppMessages('fr', { app: { emails: { receipt: { subject: 'Votre reçu' } } } });
    };
  });

  it('is chosen for a user who picked it', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(userRow({ locale: 'fr' }));
    expect((await emailLocaleForUser('u1')).locale).toBe('fr');
  });

  it('reaches the platform’s email, its subject, and English for what it left out', async () => {
    const where = { locale: 'fr', timeZone: 'UTC' };
    const html = await render(
      resolveEmailTemplate(
        'welcome',
        { userName: 'Ada', userEmail: 'ada@example.com', baseUrl: 'https://example.test' },
        where
      )
    );

    expect(html).toContain('lang="fr"');
    expect(html).toContain('Bienvenue sur');
    // Not translated by the app: the platform's English.
    expect(html).toContain('Get Started');
    expect(emailTranslator(where, 'emails.welcome')('subject', { brand: 'X' })).toBe('Bienvenue');
  });

  it('reaches an app’s own strings through the same translator', () => {
    const t = emailTranslator(
      { locale: 'fr', timeZone: 'UTC' },
      'app.emails.receipt' as Parameters<typeof emailTranslator>[1]
    ) as unknown as (key: string) => string;
    expect(t('subject')).toBe('Votre reçu');
  });
});
