/**
 * App Content-Security-Policy additions.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty and does NOT change it
 * after release, so your edits here merge cleanly on upgrade (the stable
 * contract is this file's exports, not their values).
 *
 * Auto-wired: `lib/security/headers.ts` folds these into the global CSP that
 * `proxy.ts` sets on every response, so you never edit the platform's directive
 * table. They land in `getCSPConfig()` too, so code that asks the policy whether
 * a host is allowed gets the same answer the browser does.
 *
 * Only exact `https://` origins are accepted — `https://player.vimeo.com`,
 * `https://*.example.com` (no wildcard in `appScriptSrc`), with a port in
 * 1–65535 if any. Anything else (a bare `*`, a `data:` scheme, a
 * value with whitespace or `;`) is dropped with a warning rather than widening
 * the policy, because these lists are spliced into a header.
 *
 * **Keep each list exactly as broad as the feature.** What makes an allowlist
 * acceptable is that your code only ever points at these hosts:
 *
 * - **`appFrameSrc`** — your code only builds iframe `src`s on these hosts, from
 *   a *validated* id, never from an admin's raw input. A hostile stored value
 *   should resolve to `null` (no iframe) in your resolver, upstream of the CSP
 *   ever mattering. Prefer the privacy-preserving host where one exists
 *   (`youtube-nocookie.com` over `youtube.com`).
 * - **`appScriptSrc`** — the strongest grant here: any script served from these
 *   hosts runs with this app's full privileges. Name the vendor's exact script
 *   host; a wildcard is refused here, since `*.` over a domain where others can
 *   publish would let anyone there run code in your pages.
 * - **`appConnectSrc`** — the browser may send requests (fetch, XHR, WebSocket)
 *   to these hosts. The platform keeps this at `'self'` so client code cannot
 *   ship data off-site; add only the endpoints a third-party script must reach
 *   from the browser. Server-side calls need no entry.
 * - **`appMediaSrc`** — `<audio>` and `<video>` may play from these hosts.
 *
 * A third-party widget often needs more than one: Cloudflare Turnstile, for
 * example, needs `https://challenges.cloudflare.com` in both `appScriptSrc` and
 * `appFrameSrc`.
 *
 * @example
 * ```ts
 * export const appFrameSrc: string[] = [
 *   'https://www.youtube-nocookie.com',
 *   'https://player.vimeo.com',
 * ];
 * export const appScriptSrc: string[] = ['https://challenges.cloudflare.com'];
 * export const appMediaSrc: string[] = ['https://media.example.com'];
 * ```
 *
 * Full guide: CUSTOMIZATION.md §4 · .context/security/overview.md
 *
 * (`appScriptSrc`, `appConnectSrc` and `appMediaSrc` were added after
 * `appFrameSrc` shipped. They sit above it, with no blank line between them, so
 * that a fork which has filled `appFrameSrc` takes them in an upgrade without a
 * merge conflict. Keep `appFrameSrc` last.)
 */
/** Extra `script-src` origins. Empty = platform default (`'self'` plus the per-request nonce). */
export const appScriptSrc: string[] = [];
/** Extra `connect-src` origins. Empty = platform default (`'self'` only in production). */
export const appConnectSrc: string[] = [];
/** Extra `media-src` origins. Empty = platform default (`'self'` and `blob:`). */
export const appMediaSrc: string[] = [];

/** Extra `frame-src` origins. Empty = platform default (`'self'` only). */
export const appFrameSrc: string[] = [];
