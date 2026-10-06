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
 * - 20 or more characters of `[A-Za-z0-9_-]` (base64url, cuid2, nanoid…) that
 *   contain a digit or mix upper and lower case.
 *
 * Left alone: anything shorter than 20 characters that is not a UUID or cuid
 * (`v1`, `admin`, `orchestration`, a short numeric id), and longer readable
 * slugs that are one case with no digits (`provider-models`).
 *
 * What it cannot catch — pin the route pattern with
 * `getRouteLogger(request, { endpoint })` for these:
 * - a secret under 20 characters;
 * - a secret containing other characters — a JWT (dots), anything
 *   percent-encoded, an email address (`user%40example.com`);
 * - a 20+ character secret that happens to be one case with no digits;
 * - a secret split across several short segments of a catch-all route.
 * It also collapses some harmless values (a long dated model id such as
 * `gpt-4o-mini-2024-07-18`); a log line losing that detail is the cheaper error.
 */

const PLACEHOLDER = '[param]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID = /^c[a-z0-9]{24}$/;
const LONG_HEX = /^[0-9a-f]{20,}$/i;
const LONG_TOKEN = /^[A-Za-z0-9_-]{20,}$/;

function isSensitiveSegment(segment: string): boolean {
  if (UUID.test(segment) || CUID.test(segment) || LONG_HEX.test(segment)) return true;
  if (!LONG_TOKEN.test(segment)) return false;
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
