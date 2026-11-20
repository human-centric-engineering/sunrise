/**
 * Dates, times, numbers and money for a locale (§138 t-1071).
 *
 * One set of named formats, used three ways:
 *
 * - **Server Components**: `getFormatter()` from `next-intl/server`; the
 *   request config passes {@link I18N_FORMATS} and the viewer's time zone.
 * - **Client Components**: `useFormatter()` from `next-intl`, the same.
 * - **Outside a request** (an email, a job): {@link formatterFor}.
 *
 * So `format.dateTime(d, 'short')` reads the same on a page and in an email
 * for the same person. Use these rather than `toLocaleDateString()`: those
 * take the server's locale and time zone, not the viewer's.
 */

import { createFormatter, type Formats } from 'next-intl';

/** The named formats every surface shares. */
export const I18N_FORMATS = {
  dateTime: {
    /** 20 Nov 2026 */
    short: { day: 'numeric', month: 'short', year: 'numeric' },
    /** 20 November 2026 */
    long: { day: 'numeric', month: 'long', year: 'numeric' },
    /** 20 Nov 2026, 14:05 */
    dateTime: {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    },
    /** 14:05 */
    time: { hour: 'numeric', minute: '2-digit' },
  },
  number: {
    /** 1,234.5 */
    decimal: { maximumFractionDigits: 2 },
    /** 12% */
    percent: { style: 'percent', maximumFractionDigits: 0 },
    /** 1.2K */
    compact: { notation: 'compact', maximumFractionDigits: 1 },
  },
} as const satisfies Formats;

/** The time zone used when the viewer has none, or one `Intl` does not know. */
export const DEFAULT_TIME_ZONE = 'UTC';

/** `timeZone` if `Intl` knows it, else {@link DEFAULT_TIME_ZONE}. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * A formatter for `locale` and `timeZone`, for code with no request: an
 * email, a job. Same named formats as the pages.
 */
export function formatterFor(
  locale: string,
  timeZone?: string | null
): ReturnType<typeof createFormatter> {
  return createFormatter({ locale, timeZone: safeTimeZone(timeZone), formats: I18N_FORMATS });
}
