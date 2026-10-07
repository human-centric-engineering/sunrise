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
 * Reduce an outbound URL to something safe to log (#953): its origin plus the
 * path from `collapseDynamicSegments`. Userinfo, the query string and the
 * fragment are dropped — a webhook or signed URL often carries its credential
 * in one of those, or in a path segment, and the logger redacts by key name
 * only. A value that does not parse as a URL is replaced, never echoed.
 *
 * The path inherits `collapseDynamicSegments`' limits: a secret segment it
 * does not recognise as one is kept.
 *
 * @example
 * loggableUrl('https://user:pw@example.com/hooks/Ab3dEf6hIj9kLm2nOp5qRs8t?sig=x#y');
 * // 'https://example.com/hooks/[param]'
 */
export function loggableUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '[unparseable-url]';
  }
  return `${parsed.origin}${collapseDynamicSegments(parsed.pathname)}`;
}
