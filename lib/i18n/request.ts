/**
 * next-intl's request config (§138 t-1071): the locale, messages, time zone
 * and formats for this request. Wired in `next.config.js`
 * (`createNextIntlPlugin`), and called once per request, on the first
 * translation a Server Component asks for.
 *
 * Which locale is `lib/i18n/resolve.ts`'s rule; this file only gathers its
 * inputs: the signed-in user's own choice and time zone, the default of the
 * org the request acts in (as the guards entered it, so a support session
 * gets the org it is in), the visitor cookie and `Accept-Language`.
 *
 * No i18n routing: the URL never carries the locale, so no route moves.
 * Reading cookies and headers makes rendering dynamic, which costs nothing
 * here: the root layout already reads `headers()` for the CSP nonce, so no
 * page was static before this.
 */

import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { messagesFor } from '@/lib/i18n/catalogue';
import { I18N_FORMATS, safeTimeZone } from '@/lib/i18n/format';
import { LOCALE_COOKIE_NAME } from '@/lib/i18n/locales';
import { resolveLocale, type ResolvedLocale } from '@/lib/i18n/resolve';
import { readOrgLocale } from '@/lib/tenancy/org-settings';

interface ViewerPreferences {
  userLocale: string | null;
  orgLocale: string | null;
  timeZone: string | null;
}

const NO_PREFERENCES: ViewerPreferences = { userLocale: null, orgLocale: null, timeZone: null };

/**
 * The signed-in viewer's stored choices, or none for a visitor. A failed
 * read degrades to none, with a warning: the page still renders, in the
 * visitor's browser language, rather than failing over a preference.
 */
const viewerPreferences = cache(async (): Promise<ViewerPreferences> => {
  try {
    const entry = await requestPrincipal();
    if (!entry) return NO_PREFERENCES;
    const userId = entry.principal.userId;
    const orgId = entry.principal.orgId;
    const [user, org] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { locale: true, timezone: true } }),
      orgId
        ? prisma.org.findUnique({ where: { id: orgId }, select: { settings: true } })
        : Promise.resolve(null),
    ]);
    return {
      userLocale: user?.locale ?? null,
      orgLocale: org ? readOrgLocale(org.settings, { orgId }) : null,
      timeZone: user?.timezone ?? null,
    };
  } catch (error) {
    logger.warn('i18n: could not read the viewer’s language preferences; using the browser’s', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_PREFERENCES;
  }
});

/** This request's locale and where it came from. Cached per request. */
export const requestLocale = cache(async (): Promise<ResolvedLocale & { timeZone: string }> => {
  const [prefs, cookieStore, headerList] = await Promise.all([
    viewerPreferences(),
    cookies(),
    headers(),
  ]);
  const resolved = resolveLocale({
    userLocale: prefs.userLocale,
    orgLocale: prefs.orgLocale,
    cookieLocale: cookieStore.get(LOCALE_COOKIE_NAME)?.value ?? null,
    acceptLanguage: headerList.get('accept-language'),
  });
  return { ...resolved, timeZone: safeTimeZone(prefs.timeZone) };
});

export default getRequestConfig(async () => {
  const { locale, timeZone } = await requestLocale();
  return {
    locale,
    messages: messagesFor(locale),
    timeZone,
    formats: I18N_FORMATS,
  };
});
