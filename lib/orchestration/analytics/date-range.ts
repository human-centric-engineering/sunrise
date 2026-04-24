/**
 * Analytics date-range defaults.
 *
 * Two callers need the same "30 days" default: the analytics service
 * (`resolveDateRange`) and the admin analytics page
 * (`getDefaultDates` — string form for `<input type="date">`). The
 * constant + helpers live here so the window can be changed in one
 * place.
 */

export const ANALYTICS_DEFAULT_RANGE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface AnalyticsDateRange {
  from: Date;
  to: Date;
}

/**
 * Resolve an `AnalyticsQuery`-shaped `{ from?, to? }` into a concrete
 * `{ from, to }` Date pair. When either side is missing, defaults
 * apply: `to` = now, `from` = `to` minus `ANALYTICS_DEFAULT_RANGE_DAYS`.
 */
export function resolveAnalyticsDateRange(
  query: { from?: string; to?: string },
  now: Date = new Date()
): AnalyticsDateRange {
  const to = query.to
    ? query.to.length === 10
      ? new Date(query.to + 'T23:59:59.999Z')
      : new Date(query.to)
    : now;
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - ANALYTICS_DEFAULT_RANGE_DAYS * MS_PER_DAY);
  return { from, to };
}

/**
 * Returns `YYYY-MM-DD` strings for the default analytics window, for
 * use as the `defaultValue` of `<input type="date">` controls.
 */
export function getAnalyticsDefaultDateInputs(now: Date = new Date()): {
  from: string;
  to: string;
} {
  const { from, to } = resolveAnalyticsDateRange({}, now);
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  };
}
