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
 * Collapsed (a whole segment; the shapes are compared before any decoding,
 * a declaration against the decoded segment):
 * - a segment a route declares as a credential, whatever its length or shape
 *   (`CREDENTIAL_PATHS` below for Sunrise's own routes, `appCredentialPaths` in
 *   `lib/app/credential-paths.ts` for a fork's) — the declaration is the rule,
 *   and the shapes after it are the backstop for routes nobody declared;
 * - a UUID (`8-4-4-4-12` hex);
 * - a cuid (`c` + 24 lowercase alphanumerics);
 * - hex of 20 or more characters;
 * - anything containing `@` or `%40` — an email address, raw or encoded;
 * - a JWT (`eyJ…` header, three dot-separated parts);
 * - a segment containing `:` any of whose colon-separated parts is one of
 *   these shapes (`bot123456789:AAHfiqksKZ8WmR2zSjiQ7_v4TMAKdiHm9T0`);
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
 * What the shapes cannot catch in an undeclared route — declare the route (or,
 * for an API route's own log lines, pin its pattern with
 * `getRouteLogger(request, { endpoint })`) for these:
 * - a secret under 20 characters. Deliberate: below that length a token cannot
 *   be told from a route word or a short id (`gpt-4o-mini`, `v1beta`), and the
 *   webhook secrets this exists for are longer (Slack 24, Telegram 35,
 *   Discord 68);
 * - a secret containing other characters (dots outside a JWT, `/` inside a
 *   catch-all segment);
 * - a 20+ character secret that happens to be one case with no digits, or to
 *   read as a slug;
 * - a secret split across several short segments of a catch-all route.
 * It also collapses some harmless values (a mixed-case or letter-and-digit id
 * such as `gpt-4o-mini-2024-07-18`); a log line losing that detail is the
 * cheaper error.
 */

import { appCredentialPaths } from '@/lib/app/credential-paths';

const PLACEHOLDER = '[param]';

/**
 * Sunrise's own routes with a credential in the path (t-933). better-auth's
 * reset link carries its token as a segment; it is long enough for the shape
 * rules today, but whether it stays so is better-auth's choice, not ours.
 * Patterns follow the rules `credentialPathProblem` checks.
 */
export const CREDENTIAL_PATHS: readonly string[] = ['/api/auth/reset-password/[token]'];

/** One segment of a declared pattern: a word to match, or what to collapse. */
type PatternSegment =
  { kind: 'literal'; value: string } | { kind: 'param' } | { kind: 'rest'; optional: boolean };

// A param name is anything Next accepts in a folder name between the brackets
// (`[joinRef]`, `[join-ref]`); a leading `.` is left to the catch-all forms.
const PARAM_SEGMENT = /^\[[^[\].][^[\]]*\]$/;
const REST_SEGMENT = /^\[\.\.\.[^[\]]+\]$/;
const OPTIONAL_REST_SEGMENT = /^\[\[\.\.\.[^[\]]+\]\]$/;
// Folders that organise routes without appearing in the URL: a route group
// `(public)`, a parallel-route slot `@modal`, an intercepting route `(.)photo`.
const NOT_IN_URL_SEGMENT = /^(?:\(|@)/;

/** `decodeURIComponent`, or the segment as it is when it does not decode. */
function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parsePattern(pattern: string): PatternSegment[] | string {
  if (!pattern.startsWith('/')) return 'must start with `/`';
  if (/[?#\s]/.test(pattern)) return 'must be a path only: no query, fragment or whitespace';
  const segments = pattern.replace(/\/$/, '').split('/').slice(1);
  const parsed: PatternSegment[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment === '') return 'has an empty segment (`//`)';
    if (NOT_IN_URL_SEGMENT.test(segment)) {
      return `\`${segment}\` is a route group, slot or interception folder, which is not in the URL: leave it out`;
    }
    const last = index === segments.length - 1;
    if (PARAM_SEGMENT.test(segment)) parsed.push({ kind: 'param' });
    else if (REST_SEGMENT.test(segment) || OPTIONAL_REST_SEGMENT.test(segment)) {
      if (!last) return `catch-all \`${segment}\` must be the last segment`;
      parsed.push({ kind: 'rest', optional: segment.startsWith('[[') });
    } else if (/[[\]]/.test(segment)) {
      return `\`${segment}\` is not \`[name]\`, \`[...name]\` or \`[[...name]]\``;
    } else parsed.push({ kind: 'literal', value: decodeSegment(segment) });
  }
  // A leading literal is what keeps a pattern from matching everywhere: it is
  // tried at every offset, and `/[code]` would collapse every segment of
  // every path.
  if (parsed[0]?.kind !== 'literal') return 'must start with a literal segment';
  if (!parsed.some((segment) => segment.kind !== 'literal')) {
    return 'declares no credential segment (`[name]`)';
  }
  return parsed;
}

/**
 * Why `pattern` cannot be used as a credential-path declaration, or `null`
 * when it can. A pattern that fails is skipped by `collapseDynamicSegments`,
 * which cannot log the skip (the logger depends on this module), so the tests
 * run every declaration through this instead.
 */
export function credentialPathProblem(pattern: string): string | null {
  const parsed = parsePattern(pattern);
  return typeof parsed === 'string' ? parsed : null;
}

const DECLARED_PATTERNS: readonly PatternSegment[][] = [
  ...CREDENTIAL_PATHS,
  ...appCredentialPaths,
].flatMap((pattern) => {
  const parsed = parsePattern(pattern);
  return typeof parsed === 'string' ? [] : [parsed];
});

/**
 * Mark the segments `pattern` declares as credentials, wherever it matches in
 * `segments` (decoded, so `/caf%C3%A9/…` matches a `/café/…` pattern). It is
 * tried at every offset, so a `basePath`, a locale prefix or a referrer from
 * another origin does not hide the route; a pattern also covers the paths
 * below it.
 */
function markDeclaredSegments(
  segments: readonly string[],
  pattern: readonly PatternSegment[],
  marked: boolean[]
): void {
  const [first] = pattern;
  for (let start = 0; start < segments.length; start++) {
    // Every pattern starts with a literal (`parsePattern`), so most offsets
    // are ruled out here, before any work.
    if (first?.kind !== 'literal' || segments[start] !== first.value) continue;
    const hits: number[] = [];
    let matched = true;
    for (const [offset, part] of pattern.entries()) {
      const index = start + offset;
      if (part.kind === 'rest') {
        const before = hits.length;
        for (let rest = index; rest < segments.length; rest++) {
          if (segments[rest] !== '') hits.push(rest);
        }
        matched = part.optional || hits.length > before;
        break;
      }
      const segment = segments[index];
      if (segment === undefined || segment === '') matched = false;
      else if (part.kind === 'literal') matched = segment === part.value;
      else hits.push(index);
      if (!matched) break;
    }
    if (matched) for (const index of hits) marked[index] = true;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CUID = /^c[a-z0-9]{24}$/;
const LONG_HEX = /^[0-9a-f]{20,}$/i;
const LONG_TOKEN = /^[A-Za-z0-9_\-+=~%]{20,}$/;
const JWT = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const READABLE_SLUG = /^(?:[a-z]+|\d+)(?:-(?:[a-z]+|\d+))+$/;

function isSensitiveSegment(segment: string): boolean {
  // `prefix<id>:<secret>` (a Telegram bot path, `bot123456:AAH…`): each
  // colon-separated part is judged on its own, so a secret part collapses the
  // whole segment while `projects/x:batchGet` keeps its short verb.
  if (segment.includes(':')) return segment.split(':').some(isSensitiveSegment);
  if (UUID.test(segment) || CUID.test(segment) || LONG_HEX.test(segment)) return true;
  if (segment.includes('@') || segment.toLowerCase().includes('%40')) return true;
  if (JWT.test(segment)) return true;
  if (!LONG_TOKEN.test(segment) || READABLE_SLUG.test(segment)) return false;
  return /\d/.test(segment) || (/[a-z]/.test(segment) && /[A-Z]/.test(segment));
}

/**
 * Replace every declared credential segment, and every id- or
 * credential-shaped one, of `pathname` with `[param]`. Expects a pathname with
 * no query string.
 *
 * @example
 * collapseDynamicSegments('/api/v1/users/cmtd5heg2001804ky8pgo6odx/posts');
 * // '/api/v1/users/[param]/posts'
 */
export function collapseDynamicSegments(pathname: string): string {
  return collapseSegments(pathname, true);
}

/**
 * `collapseDynamicSegments`, with the route declarations optionally left out:
 * they describe URLs, and a source file's path is not one (see `scrubUrl`).
 */
function collapseSegments(pathname: string, applyDeclarations: boolean): string {
  const segments = pathname.split('/');
  const declared = new Array<boolean>(segments.length).fill(false);
  if (applyDeclarations) {
    const decoded = segments.map(decodeSegment);
    for (const pattern of DECLARED_PATTERNS) markDeclaredSegments(decoded, pattern, declared);
  }
  return segments
    .map((segment, index) =>
      declared[index] || isSensitiveSegment(segment) ? PLACEHOLDER : segment
    )
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
 * Path tails kept as they are: Next.js build assets (under any `basePath`) and,
 * in a file path only, installed packages (`node_modules/@scope/pkg/…`). They
 * carry no request data, and a source-map lookup or Sentry's issue grouping
 * needs them exactly as built. The segments before the tail are still
 * collapsed, so a token placed ahead of one is not exempt.
 */
const BUILD_ASSETS = '/_next/static/';
const FILE_PATH_KEPT = [BUILD_ASSETS, '/node_modules/'];

/** An absolute URL's `scheme://authority`, and the rest. */
const ABSOLUTE_URL = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)?(.*)$/is;

/**
 * Reduce a URL to its origin and its path for logging or error tracking (#952):
 * the query string, the fragment and any `user:password@` are dropped, and
 * every id- or credential-shaped path segment is collapsed to `[param]`. Accepts
 * an absolute URL or a relative path. A build-asset or package tail keeps its
 * path (see `FILE_PATH_KEPT`).
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
  // A web URL keeps only a build-asset tail; a file path (no origin, or a
  // non-http scheme such as `file://` or `app://`) also keeps a package tail.
  const web = /^https?:/i.test(origin);
  const kept = web ? [BUILD_ASSETS] : FILE_PATH_KEPT;
  // A path under a non-http scheme (`app://`, `file://`, `webpack-internal://`)
  // is a stack frame's file, not a route, so the route declarations stay off
  // it: `/m/[joinRef]` would otherwise turn `app:///lib/m/scoring.js` into
  // `app:///lib/m/[param]` and break its source map. The shape rules still
  // apply. A path with no origin keeps them: it cannot be told from a request
  // path (`GET /m/<code>/widget.js`), and losing a frame's detail is the
  // cheaper error.
  const declarations = web || origin === '';
  const tail = Math.min(...kept.map((prefix) => path.indexOf(prefix)).filter((i) => i >= 0));
  if (!Number.isFinite(tail)) return origin + collapseSegments(path, declarations);
  return origin + collapseSegments(path.slice(0, tail), declarations) + path.slice(tail);
}

/**
 * A URL in free text: an absolute URL, a scheme-less `host.tld/path` or
 * `1.2.3.4:port/path`, or a path starting with `/`, not preceded by a word
 * character, `/`, `.` or `-`. So `GET /x`, `fetch(https://…)`,
 * `at f (https://…:1:2)` and `see h.com/x` match, but `a/b` does not. A URL
 * ends at whitespace, a quote or `<>`, so one inside JSON or markup takes
 * nothing after it. Commas, brackets and parentheses stay part of it, because
 * browsers leave them unencoded in paths (`/wiki/Foo_(bar)?token=…`), and a
 * trailing one is handed back as punctuation. A scheme-less host may be
 * followed by `/`, `?` or `#`; it needs a dotted TLD or an IPv4 address, so a
 * bare `localhost:3000/…` (dev only) is not matched, though with a scheme it is.
 */
const URL_IN_TEXT =
  /(?<![\w/.-])(?:[a-z][a-z0-9+.-]*:\/\/|(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?(?=[/?#])|\/)[^\s<>"'`?#]*(?:[?#][^\s<>"'`]*)?/gi;

/** Punctuation that ends a sentence or a quoted value, not the URL before it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"`)\]}>&]+$/;

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

/** How deep `scrubUrlsDeep` follows nested objects and arrays. */
const MAX_SCRUB_DEPTH = 8;

/** What `scrubUrlsDeep` puts in place of an object nested past `MAX_SCRUB_DEPTH`. */
const DEPTH_LIMIT = '[depth limit]';

/**
 * Copy of an Error with `scrubUrlsInText` applied to its message, its stack
 * and its own properties (such as `code`), keeping its name.
 */
export function scrubUrlsInError(error: Error): Error {
  return scrubError(error, 0);
}

/**
 * The non-enumerable flag `@sentry/core` sets on an exception it has captured
 * (`checkOrSetAlreadyCaught`), so the same error is not reported twice.
 */
const SENTRY_CAPTURED_MARKER = '__sentry_captured__';

/** Non-enumerable properties an object spread misses: `new Error(m, { cause })`, `AggregateError`. */
const CHAINED_ERROR_KEYS = ['cause', 'errors'];

/**
 * The built-in error classes whose prototype a plain `Error` can take on safely.
 * Others (a DOMException, a class whose getters read `#private` fields) have
 * prototype getters that throw on an object they did not construct, so their
 * copy stays a plain `Error` that keeps the original's name.
 */
const BUILT_IN_ERROR_PROTOTYPES: ReadonlySet<unknown> = new Set<unknown>([
  Error.prototype,
  TypeError.prototype,
  RangeError.prototype,
  ReferenceError.prototype,
  SyntaxError.prototype,
  EvalError.prototype,
  URIError.prototype,
  AggregateError.prototype,
]);

/** Read a property of a foreign object without letting a throwing getter escape. */
function safeRead(source: object, key: string): unknown {
  try {
    return Reflect.get(source, key);
  } catch {
    return undefined;
  }
}

function scrubError(error: Error, depth: number): Error {
  const message = safeRead(error, 'message');
  const scrubbed = new Error(typeof message === 'string' ? scrubUrlsInText(message) : '');
  const prototype: unknown = Object.getPrototypeOf(error);
  const name = safeRead(error, 'name');
  if (BUILT_IN_ERROR_PROTOTYPES.has(prototype) && typeof prototype === 'object') {
    // Keep the subclass (TypeError, AggregateError…) and an own name, if any.
    Object.setPrototypeOf(scrubbed, prototype);
    if (Object.prototype.hasOwnProperty.call(error, 'name') && typeof name === 'string') {
      scrubbed.name = name;
    }
  } else if (typeof name === 'string' && name !== scrubbed.name) {
    Object.defineProperty(scrubbed, 'name', { value: name, writable: true, configurable: true });
  }
  const stack = safeRead(error, 'stack');
  scrubbed.stack = typeof stack === 'string' ? scrubUrlsInText(stack) : undefined;
  const own = scrubUrlsDeep({ ...error }, depth + 1);
  if (isPlainRecord(own)) Object.assign(scrubbed, own);
  // Chained errors, scrubbed too, so Sentry's linkedErrors can still follow
  // them; and Sentry's already-captured marker, so a second report of an
  // error Sentry caught itself is still dropped as a duplicate.
  for (const key of [...CHAINED_ERROR_KEYS, SENTRY_CAPTURED_MARKER]) {
    if (!Object.prototype.hasOwnProperty.call(error, key)) continue;
    const value = safeRead(error, key);
    Object.defineProperty(scrubbed, key, {
      value: key === SENTRY_CAPTURED_MARKER ? value : scrubUrlsDeep(value, depth + 1),
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  return scrubbed;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * `scrubUrlsInText` applied to every string in a value: strings, arrays, plain
 * objects (to a bounded depth) and Errors (with their `cause` chain), each
 * copied; a `URL` object becomes its scrubbed href; a Date is returned as it
 * is; any other object (a class instance, a Map) becomes a plain object of its
 * own properties, scrubbed. An object nested past the depth cap becomes
 * `'[depth limit]'`.
 *
 * @example
 * scrubUrlsDeep({ request: { url: 'https://app.example.com/s/Xk9fQ2mZp4LrT7vB1nWc8sYd?a=1' } });
 * // { request: { url: 'https://app.example.com/s/[param]' } }
 */
export function scrubUrlsDeep(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubUrlsInText(value);
  // Fail closed at the cap: an object nested deeper is replaced, not passed on
  // unscrubbed.
  if (depth >= MAX_SCRUB_DEPTH) {
    return typeof value === 'object' && value !== null ? DEPTH_LIMIT : value;
  }
  if (value instanceof Error) return scrubError(value, depth + 1);
  // A URL object would print its full href through `toJSON()`.
  if (value instanceof URL) return scrubUrl(value.href);
  if (Array.isArray(value)) return value.map((item: unknown) => scrubUrlsDeep(item, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null) {
    // A plain object, or a class instance, Map or Set: Sentry serializes an
    // instance's own properties, so it is copied as a plain object of them,
    // scrubbed (a Map or Set has none and becomes `{}`). Failing closed beats
    // passing an unknown object on unscrubbed.
    const scrubbed: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) scrubbed[key] = scrubUrlsDeep(item, depth + 1);
    return scrubbed;
  }
  return value;
}

/**
 * Reduce an outbound URL to something safe to log (#953): its origin plus the
 * path from `collapseDynamicSegments`. Userinfo, the query string and the
 * fragment are dropped — a webhook or signed URL often carries its credential
 * in one of those, or in a path segment, and the logger redacts by key name
 * only. A value that does not parse as a URL, or is not http(s) — whose origin
 * would be `null` with the payload left in the path — is replaced, never echoed.
 *
 * The path inherits `collapseDynamicSegments`' limits: a secret segment it
 * does not recognise as one is kept. `null` and `undefined` pass through, the
 * way `loggablePath` passes an absent path through.
 *
 * @example
 * loggableUrl('https://user:pw@example.com/hooks/Ab3dEf6hIj9kLm2nOp5qRs8t?sig=x#y');
 * // 'https://example.com/hooks/[param]'
 */
export function loggableUrl(url: string): string;
export function loggableUrl(url: string | null | undefined): string | null | undefined;
export function loggableUrl(url: string | null | undefined): string | null | undefined {
  if (url === null || url === undefined) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '[unparseable-url]';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '[non-http-url]';
  return `${parsed.origin}${collapseDynamicSegments(parsed.pathname)}`;
}

/**
 * An absolute http(s) URL in free text. It ends at whitespace, a quote or
 * `<>`, and never on trailing punctuation: a `,` or `)` left on the last
 * segment would stop `collapseDynamicSegments` recognising a token there.
 */
const HTTP_URL_IN_TEXT = /\bhttps?:\/\/[^\s'"`<>]*[^\s'"`<>.,;:!?)\]}]/gi;

/**
 * An http(s) URL's userinfo, up to its `@`. Stripped before the URL is
 * matched, so a quote inside a password cannot end the match before the
 * password does. It stops at `/`, `?` and `#` as URL parsing does: an `@` after
 * one of them is in the path, query or fragment, and taking it for userinfo
 * would delete the real host. It also stops at whitespace and `<>`, and at a
 * quote beside a separator (`","`, `':`, `']`): the logger runs this over
 * serialised JSON and lists, where `"https://h.com","email":"a@b.com"` would
 * otherwise read as userinfo up to the email's `@`, deleting the field and
 * naming the wrong host. A bare `,` is kept — it is legal in userinfo.
 */
const USERINFO_IN_TEXT = /\b(https?:\/\/)(?:(?!["'`]\s*[,:\]})]|[,[{(]\s*["'`])[^\s/?#@<>])*@/gi;

/**
 * Every absolute http(s) URL in `text` replaced with its `loggableUrl()` form
 * (t-778). The logger applies this to every string it writes, whatever the
 * key, so an outbound URL passed to a log line, an error message or a stack
 * trace has its credential dropped without each call site having to remember
 * `loggableUrl`. Relative paths are left to `loggablePath` at the call site
 * (#950): they are the request's own route, not a third party's address.
 *
 * @example
 * loggableUrlsInText('POST https://hooks.slack.com/services/T0/B0/Xk9fQ2mZp4LrT7vB1nWc8sYd failed');
 * // 'POST https://hooks.slack.com/services/T0/B0/[param] failed'
 */
export function loggableUrlsInText(text: string): string {
  if (!text.includes('://')) return text;
  return text.replace(USERINFO_IN_TEXT, '$1').replace(HTTP_URL_IN_TEXT, (url) => loggableUrl(url));
}
