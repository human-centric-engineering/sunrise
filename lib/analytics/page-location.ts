/**
 * What of a page's address may reach an analytics provider (t-780).
 *
 * A page view used to carry `window.location.href` whole: the query string,
 * the fragment, and path segments that can be live credentials (a `/s/<token>`
 * share page) or an email address. The provider keeps that under its own
 * retention, outside Sunrise's erasure and export. This is the same exposure
 * t-772 closed for browser error reports.
 *
 * **The rule (owner ruling, 2026-10-13, option b):**
 * - path segments that look like an id or a secret are collapsed to `[param]`
 *   by `collapseDynamicSegments`, the scrubber logs and error reports use;
 * - the query keeps only the attribution parameters in
 *   {@link ATTRIBUTION_QUERY_PARAMS}, so campaign reporting still works, and
 *   drops everything else, so a parameter nobody anticipated (a reset token,
 *   `?email=`) cannot leak;
 * - the fragment and any `user:password@` are dropped.
 *
 * A fork that needs another parameter adds it to the list.
 *
 * This covers what Sunrise passes to a provider. What a provider's own script
 * reads by itself is handled per provider, and what is out of reach (such as
 * the referrer Plausible's script sends) is listed in
 * `.context/analytics/providers.md`.
 */

import { collapseDynamicSegments } from '@/lib/logging/redact-path';
import type { PageProperties } from '@/lib/analytics/types';

/** Query parameters a page view keeps: campaign tags and ad click ids. */
export const ATTRIBUTION_QUERY_PARAMS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
];

/** Whether an absolute URL names a path at all (`https://h.com/…`, not `https://h.com?x`). */
const BARE_ORIGIN_HAS_PATH = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\//i;

/** Base for resolving a relative URL, never emitted. */
const RELATIVE_BASE = 'http://relative.invalid';

/**
 * A query string reduced to its attribution parameters, without a leading
 * `?`. `undefined` when none remain.
 *
 * @example
 * analyticsSearch('?utm_source=news&token=abc&email=a%40b.c');
 * // 'utm_source=news'
 */
export function analyticsSearch(search: string | null | undefined): string | undefined {
  if (!search) return undefined;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    if (ATTRIBUTION_QUERY_PARAMS.includes(key.toLowerCase())) kept.append(key, value);
  }
  return kept.toString() || undefined;
}

/** A pathname with id- and secret-shaped segments collapsed to `[param]`. */
export function analyticsPath(path: string | null | undefined): string | undefined {
  return path ? collapseDynamicSegments(path) : undefined;
}

/**
 * A URL as a page view may record it: origin, collapsed path and attribution
 * query only. A relative URL stays relative. Anything that is not http(s), or
 * does not parse, becomes `undefined` rather than being passed on.
 *
 * @example
 * analyticsUrl('https://app.example.com/s/Xk9fQ2mZp4LrT7vB1nWc8sYd?utm_source=x&email=a%40b.c#top');
 * // 'https://app.example.com/s/[param]?utm_source=x'
 */
export function analyticsUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  let relative = false;
  try {
    parsed = new URL(url);
  } catch {
    try {
      parsed = new URL(url, RELATIVE_BASE);
      relative = true;
    } catch {
      return undefined;
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const search = analyticsSearch(parsed.search);
  const origin = relative ? '' : parsed.origin;
  // A bare origin (`https://google.com`, a common referrer) stays bare rather
  // than gaining the `/` URL parsing adds.
  const path = !relative && !BARE_ORIGIN_HAS_PATH.test(url) ? '' : parsed.pathname;
  return `${origin}${collapseDynamicSegments(path)}${search ? `?${search}` : ''}`;
}

/**
 * Page-view properties with `url`, `path`, `search` and `referrer` reduced by
 * the rule above. Other properties pass through; a property that was absent
 * stays absent.
 */
export function analyticsPageProperties(properties: PageProperties): PageProperties;
export function analyticsPageProperties(properties: undefined): undefined;
export function analyticsPageProperties(
  properties: PageProperties | undefined
): PageProperties | undefined;
export function analyticsPageProperties(
  properties: PageProperties | undefined
): PageProperties | undefined {
  if (!properties) return properties;
  const { url, path, search, referrer } = properties;
  return {
    ...properties,
    ...(url !== undefined && { url: analyticsUrl(url) }),
    ...(path !== undefined && { path: analyticsPath(path) }),
    ...(search !== undefined && { search: analyticsSearch(search) }),
    ...(referrer !== undefined && { referrer: analyticsUrl(referrer) }),
  };
}

/** The current page's address, reduced — for a provider's fallback when no `url` is passed. */
export function currentPageUrl(): string | undefined {
  return typeof window !== 'undefined' ? analyticsUrl(window.location.href) : undefined;
}

/** The current page's path, reduced. */
export function currentPagePath(): string | undefined {
  return typeof window !== 'undefined' ? analyticsPath(window.location.pathname) : undefined;
}

/** The current page's referrer, reduced. */
export function currentReferrer(): string | undefined {
  return typeof document !== 'undefined' ? analyticsUrl(document.referrer) : undefined;
}
