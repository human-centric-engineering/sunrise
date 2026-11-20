/**
 * A visitor's own choice of interface language (§138 t-1071)
 *
 * PUT /api/v1/locale — `{ locale: string | null }`: keep the choice in the
 *     `sunrise_locale` cookie, or clear it (`null`) so the browser's
 *     `Accept-Language` decides again. The locale must be one the interface has
 *     a catalogue for.
 *
 * Public: it is how someone who has not signed in picks a language. It sets
 * a cookie on the caller and touches nothing else, so there is nothing to
 * guard. A signed-in user's own choice is `User.locale`, set through
 * `PATCH /api/v1/users/me`; it ranks above this cookie, which only matters for
 * pages they see before signing in.
 *
 * The cookie is a preference the visitor set, like the theme, so it sits in
 * the consent config's "essential" category. Rate limited by the API section
 * cap in `proxy.ts`, keyed on IP for an anonymous caller.
 */

import type { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { handleAPIError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { LOCALE_COOKIE_MAX_AGE, LOCALE_COOKIE_NAME } from '@/lib/i18n/locales';
import { localeChoiceBodySchema } from '@/lib/validations/locale';

export async function PUT(request: NextRequest): Promise<Response> {
  try {
    const { locale } = await validateRequestBody(request, localeChoiceBodySchema);

    const store = await cookies();
    if (locale) {
      store.set(LOCALE_COOKIE_NAME, locale, {
        path: '/',
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        // Read on the server only; nothing in the page needs it.
        httpOnly: true,
      });
    } else {
      store.delete(LOCALE_COOKIE_NAME);
    }
    return successResponse({ locale });
  } catch (error) {
    return handleAPIError(error);
  }
}
