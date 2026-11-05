/**
 * App frame-ancestors: which other sites may show a page of this app inside a
 * frame (#887).
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's export, not its body).
 *
 * Empty, it answers `[]` everywhere and every response is refused framing:
 * `frame-ancestors 'none'` and `X-Frame-Options: DENY`. This is the seam for
 * one family of pages that a customer embeds on their own site — an embeddable
 * form, a booking widget, a questionnaire — not for framing the whole app.
 *
 * **Only paths under a prefix in `lib/app/frameable-paths.json` ask it.** List
 * the prefixes of the pages you frame there (`"/embed/"`); `proxy.ts` awaits
 * this for a request under one of them, before it sets the security headers,
 * and never calls it for any other path. A non-empty answer replaces
 * `frame-ancestors 'none'` with those origins and drops `X-Frame-Options` for
 * that response, since that header cannot name a site. `next.config.js` leaves
 * the same prefixes out of its static `X-Frame-Options: DENY`, which it could
 * not remove per request. On a listed prefix every page still gets DENY and
 * `frame-ancestors 'none'` whenever this answers `[]`, so listing a prefix
 * frames nothing by itself. The exceptions are the proxy's early replies (the 403 origin check, the 429 rate limit, its redirects),
 * which return before the security headers are set and so carry no framing
 * header on a listed prefix. They are JSON or redirects, with nothing to click.
 *
 * **Contract.**
 * - Return exact `https://` origins, no wildcard and no path
 *   (`https://www.customer-site.com`). Outside production
 *   `http://localhost[:port]` is accepted too, for trying an embed locally. The
 *   platform validates every answer and drops anything else with a warning,
 *   because the list is spliced into a header.
 * - Keep it cheap. It runs on every request under a listed prefix, and a slow
 *   answer holds that page up, so cache whatever needs I/O.
 * - A malformed answer (not an array, a non-string entry, a port outside
 *   1–65535) is dropped like an invalid origin. Each bad value is logged once.
 * - A throw is logged and treated as `[]`: the page is not framed.
 *
 * **A framed page usually gets no session cookie.** Inside a frame on another
 * site the browser does not send this app's `SameSite=Lax` session cookie, so
 * frame pages that work signed out. (A parent on this app's own registrable
 * domain, e.g. `https://customer.app.com` framing `app.com`, is same-site, and
 * does get the cookie.)
 *
 * **The proxy does not run on image-like paths.** Its matcher skips `_next/static`, `_next/image`,
 * `favicon.ico` and any path ending `.svg|.png|.jpg|.jpeg|.gif|.webp`, so on a
 * listed prefix such a path gets no framing header at all. Keep page routes
 * under a framable prefix from ending in one of those extensions.
 *
 * @example
 * ```ts
 * export async function resolveAppFrameAncestors(request: Request): Promise<string[]> {
 *   const { pathname } = new URL(request.url);
 *   if (!pathname.startsWith('/embed/')) return [];
 *   const widgetId = pathname.split('/')[2];
 *   return getAllowedEmbedOrigins(widgetId); // your lookup, cached
 * }
 * ```
 *
 * Full guide: .context/security/overview.md · CUSTOMIZATION.md §4
 */

/*
 * `async` is the seam's contract, not an implementation detail: a resolver that
 * frames per customer reads stored data, and the empty default must not force a
 * fork to change the signature just to add an await.
 */
/** The origins allowed to frame this request's page. `[]` = none (the platform default). */
// eslint-disable-next-line @typescript-eslint/require-await
export async function resolveAppFrameAncestors(_request: Request): Promise<string[]> {
  return [];
}
