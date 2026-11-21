/**
 * Which language an email goes out in, and the strings to write it with
 * (§138 t-1075).
 *
 * An email has no request to read a language from, so each send site works
 * it out from who receives it, here, before rendering:
 *
 * - **A user:** their own choice (`User.locale`), then the default of their
 *   org, then `en` ({@link emailLocaleForUser}). Their org is the one a
 *   sign-in would start them in (`sessionOrgOf`).
 * - **Not a user yet:** the org's default ({@link emailLocaleForOrg}), or a
 *   tag the send site holds, such as the language a waitlist entry was
 *   joined in, ahead of it ({@link emailLocaleFrom}).
 *
 * The visitor cookie and `Accept-Language` steps of the page resolution do
 * not apply: a mail is read later, somewhere else. `sendEmail` takes no
 * locale; the template and the subject are rendered in one before it is
 * called.
 *
 * Templates translate through `emailTranslator()` (`lib/email/translate.ts`,
 * next-intl's `createTranslator` outside a request) and format dates and numbers with
 * `formatterFor()` from `lib/i18n/format.ts`, so an email reads the same as
 * a page for the same person. An app's own templates do the same, with
 * their strings under `app.` in the catalogue (`lib/app/messages.ts`).
 *
 * @see .context/ui/i18n.md
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { DEFAULT_EMAIL_LOCALE, type EmailLocale } from '@/lib/email/translate';
import { safeTimeZone } from '@/lib/i18n/format';
import { resolveLocale } from '@/lib/i18n/resolve';
import { sessionOrgOf } from '@/lib/tenancy/membership';
import { readOrgLocale } from '@/lib/tenancy/org-settings';

export { DEFAULT_EMAIL_LOCALE, type EmailLocale } from '@/lib/email/translate';

/**
 * The email locale from stored choices, most specific first: the first that
 * names a supported locale wins, else `en`. A tag with no catalogue (an app
 * stopped registering it) is skipped, as on a page.
 */
export function emailLocaleFrom(inputs: {
  userLocale?: string | null;
  orgLocale?: string | null;
  timeZone?: string | null;
}): EmailLocale {
  const { locale } = resolveLocale({ userLocale: inputs.userLocale, orgLocale: inputs.orgLocale });
  return { locale, timeZone: safeTimeZone(inputs.timeZone) };
}

/**
 * The locale for an email to the user `userId`: their own choice, then
 * their org's default, then `en`; in their time zone.
 *
 * Their org is the one a sign-in starts them in. A user whose membership is
 * not written yet (a signup's welcome, sent before it) gets the org their
 * signup recorded. Never throws: a failed read is logged and the email goes
 * in English rather than not at all. `orgId`, when the send site knows the
 * org the email is about (an invitation into it), is read when the user has
 * no choice of their own, ahead of their usual org.
 */
export async function emailLocaleForUser(
  userId: string,
  options: { orgId?: string | null } = {}
): Promise<EmailLocale> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        locale: true,
        timezone: true,
        signupOrgId: true,
        orgMemberships: {
          select: { orgId: true, org: { select: { status: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });
    if (!user) return DEFAULT_EMAIL_LOCALE;
    const orgId = options.orgId ?? sessionOrgOf(user.orgMemberships) ?? user.signupOrgId;
    // Only the chosen org's settings: a user in many orgs needs one of them.
    const orgLocale = await orgLocaleOf(orgId);
    return emailLocaleFrom({ userLocale: user.locale, orgLocale, timeZone: user.timezone });
  } catch (error) {
    logger.warn('Email: could not read the recipient’s language; writing in English', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return DEFAULT_EMAIL_LOCALE;
  }
}

/**
 * The locale for an email to someone who is not a user (an invitee, a
 * configured address), on behalf of `orgId`: a tag the send site holds,
 * then the org's default, then `en`; in UTC. Never throws, as
 * {@link emailLocaleForUser}.
 */
export async function emailLocaleForOrg(
  orgId: string | null | undefined,
  options: { locale?: string | null } = {}
): Promise<EmailLocale> {
  try {
    return emailLocaleFrom({ userLocale: options.locale, orgLocale: await orgLocaleOf(orgId) });
  } catch (error) {
    logger.warn('Email: could not read the org’s language; writing in English', {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
    return emailLocaleFrom({ userLocale: options.locale });
  }
}

/**
 * The locale for an email to the address `email`: the user who holds it, as
 * {@link emailLocaleForUser}, else `orgId`'s default. For an invitation,
 * whose invitee may already have an account.
 */
export async function emailLocaleForAddress(
  email: string,
  orgId: string | null | undefined
): Promise<EmailLocale> {
  let userId: string | null = null;
  try {
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });
    userId = user?.id ?? null;
  } catch (error) {
    logger.warn('Email: could not look up the recipient; using the org’s language', {
      orgId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return userId ? emailLocaleForUser(userId, { orgId }) : emailLocaleForOrg(orgId);
}

async function orgLocaleOf(orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null;
  const org = await prisma.org.findUnique({ where: { id: orgId }, select: { settings: true } });
  return org ? readOrgLocale(org.settings, { orgId }) : null;
}
