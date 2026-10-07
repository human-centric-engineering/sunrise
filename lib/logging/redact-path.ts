/**
 * Collapse identifier- and credential-shaped path segments for logging (#685).
 *
 * A resolved pathname is not safe to log: a route like `/api/v1/x/[token]` or a
 * page like `/s/[token]` puts a live bearer credential in the path, and the
 * logger redacts by key name only — it never looks inside a value — so the
 * credential reaches stdout and the admin log buffer verbatim under `endpoint`
 * or `path`. This replaces each segment that looks like an id or a secret with
 * `[param]`, so a log line names the route shape rather than the value.
 *
 * Collapsed (a whole segment, compared before any decoding):
 * - a UUID (`8-4-4-4-12` hex);
 * - a cuid (`c` + 24 lowercase alphanumerics);
 * - hex of 20 or more characters;
 * - anything containing `@` or `%40` — an email address, raw or encoded;
 * - a JWT (`eyJ…` header, three dot-separated parts);
 * - 20 or more characters of `[A-Za-z0-9_-+=~%]` (base64url or standard base64,
 *   cuid2, nanoid, a percent-encoded token…) that contain a digit or mix upper
 *   and lower case — unless the segment is a
 *   readable slug: hyphen-separated parts that are each all-lowercase letters
 *   or all digits (`how-we-scaled-to-10000-users`, `pricing-2026`).
 *
 * Left alone: anything shorter than 20 characters that is not one of the
 * shapes above (`v1`, `admin`, `orchestration`, a short numeric id), and
 * readable slugs of any length (`provider-models`).
 *
 * What it cannot catch — pin the route pattern with
 * `getRouteLogger(request, { endpoint })` for these:
 * - a secret under 20 characters;
 * - a secret containing other characters (dots outside a JWT, `/` inside a
 *   catch-all segment);
 * - a 20+ character secret that happens to be one case with no digits, or to
 *   read as a slug;
 * - a secret split across several short segments of a catch-all route.
 * It also collapses some harmless values (a mixed-case or letter-and-digit id
 * such as `gpt-4o-mini-2024-07-18`); a log line losing that detail is the
 * cheaper error.
 */

const PLACEHOLDER = '[param]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID = /^c[a-z0-9]{24}$/;
const LONG_HEX = /^[0-9a-f]{20,}$/i;
const LONG_TOKEN = /^[A-Za-z0-9_\-+=~%]{20,}$/;
const JWT = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const READABLE_SLUG = /^(?:[a-z]+|\d+)(?:-(?:[a-z]+|\d+))+$/;

function isSensitiveSegment(segment: string): boolean {
  if (UUID.test(segment) || CUID.test(segment) || LONG_HEX.test(segment)) return true;
  if (segment.includes('@') || segment.toLowerCase().includes('%40')) return true;
  if (JWT.test(segment)) return true;
  if (!LONG_TOKEN.test(segment) || READABLE_SLUG.test(segment)) return false;
  return /\d/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment));
}

/**
 * Replace every id- or credential-shaped segment of `pathname` with `[param]`.
 * Expects a pathname with no query string.
 *
 * @example
 * collapseDynamicSegments('/api/v1/users/cmtd5heg2001804ky8pgo6odx/posts');
 * // '/api/v1/users/[param]/posts'
 */
export function collapseDynamicSegments(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => (isSensitiveSegment(segment) ? PLACEHOLDER : segment))
    .join('/');
}

/**
 * `collapseDynamicSegments` for a path that may be absent — the shape of
 * `request.nextUrl?.pathname` in a log field.
 */
export function loggablePath(pathname: string | undefined): string | undefined {
  return pathname === undefined ? undefined : collapseDynamicSegments(pathname);
}

/**
 * Next.js build assets (under any `basePath`): their URLs carry no request
 * data, and a source-map lookup needs the path exactly as built.
 */
const BUILD_ASSET_PATH = '/_next/static/';

/** An absolute URL's `scheme://authority`, and the rest. */
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/is;

/**
 * Reduce a URL to its origin and its path for logging or error tracking (#952):
 * the query string, the fragment and any `user:password@` are dropped, and
 * every id- or credential-shaped path segment is collapsed to `[param]`. Accepts
 * an absolute URL or a relative path. A Next.js build asset keeps its path.
 *
 * @example
 * scrubUrl('https://app.example.com/s/Xk9fQ2mZp4LrT7vB1nWc8sYd?email=a%40b.c#x');
 * // 'https://app.example.com/s/[param]'
 */
export function scrubUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const withoutQuery = cut === -1 ? url : url.slice(0, cut);
  const match = ABSOLUTE_URL.exec(withoutQuery);
  const origin = (match?.[1] ?? '').replace(/\/\/[^/]*@/, '//');
  const path = match?.[2] ?? '';
  return origin + (path.includes(BUILD_ASSET_PATH) ? path : collapseDynamicSegments(path));
}

/**
 * An absolute URL, or a path starting with `/`, not preceded by a word
 * character or `/` — so `GET /x`, `fetch(https://…)` and `at f (https://…:1:2)`
 * match, but `a/b` does not.
 */
const URL_IN_TEXT = /(?<![\w/])(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s()]*/gi;

/** Punctuation that ends a sentence or a quoted value, not the URL before it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"`\]}>&]+$/;

/** A stack frame's `:line` or `:line:column` suffix. */
const LINE_COLUMN = /(?::\d+){1,2}$/;

/**
 * `scrubUrl` applied to every URL and path in free text: a span or
 * transaction name (`GET /s/<token>`), or a stack trace, whose frames for an
 * inline script carry the page URL.
 *
 * @example
 * scrubUrlsInText('GET https://app.example.com/s/Xk9fQ2mZp4LrT7vB1nWc8sYd?a=1');
 * // 'GET https://app.example.com/s/[param]'
 */
export function scrubUrlsInText(text: string): string {
  return text.replace(URL_IN_TEXT, (found) => {
    const punctuation = TRAILING_PUNCTUATION.exec(found)?.[0] ?? '';
    const url = found.slice(0, found.length - punctuation.length);
    const lineColumn = LINE_COLUMN.exec(url)?.[0] ?? '';
    return scrubUrl(url.slice(0, url.length - lineColumn.length)) + lineColumn + punctuation;
  });
}
