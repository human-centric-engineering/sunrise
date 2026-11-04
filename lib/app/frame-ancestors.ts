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
 * Auto-wired: `proxy.ts` awaits this on every request it handles, before it
 * sets the security headers. A non-empty answer replaces `frame-ancestors
 * 'none'` with those origins and drops `X-Frame-Options` for that response,
 * since that header cannot name a site.
 *
 * **List the path prefixes in `lib/app/frameable-paths.json` too.**
 * `next.config.js` adds its own `X-Frame-Options: DENY` to every path except
 * those, and a header it adds cannot be removed per request, so a page answered
 * here but outside that list still refuses framing. On a listed prefix every
 * page still gets DENY and `frame-ancestors 'none'` whenever this answers `[]`,
 * so listing a prefix frames nothing by itself. The exceptions are the proxy's
 * early replies (the 403 origin check, the 429 rate limit, its redirects),
 * which return before the security headers are set and so carry no framing
 * header on a listed prefix. They are JSON or redirects, with nothing to click.
 *
 * **Contract.**
 * - Return exact `https://` origins, no wildcard and no path
 *   (`https://www.customer-site.com`). Outside production
 *   `http://localhost[:port]` is accepted too, for trying an embed locally. The
 *   platform validates every answer and drops anything else with a warning,
 *   because the list is spliced into a header.
 * - Keep it cheap. It runs on every request, so answer `[]` from the path alone
 *   for anything you do not frame, and cache whatever needs I/O.
 * - A throw is logged and treated as `[]`: the page is not framed.
 *
 * **A framed page is cross-site.** Inside another site's frame the browser does
 * not send this app's session cookie (`SameSite=Lax`), so frame pages that work
 * signed out.
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
