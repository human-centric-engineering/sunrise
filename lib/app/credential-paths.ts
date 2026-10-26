/**
 * App route patterns whose dynamic segments are credentials.
 *
 * **Fork-owned scaffold** — Sunrise ships this empty (`[]`) and does NOT change
 * it after release, so your edits merge cleanly on upgrade (the stable contract
 * is this export, not its value).
 *
 * List a route here when holding its URL is the access: a share, invite, join
 * or room code in the path. Every logged, reported or analytics path goes
 * through `collapseDynamicSegments()` (`lib/logging/redact-path.ts`), which
 * guesses a credential from its shape and deliberately leaves anything under 20
 * characters alone. A segment you declare here is collapsed to `[param]`
 * whatever its length: in the proxy's access log, the guards' log lines, client
 * error reports, Sentry events and page-view analytics.
 *
 * Write each entry as the route's pattern, the way its folder is named:
 * `[name]` for one segment, `[...name]` or `[[...name]]` for every segment from
 * there on, leaving out folders that are not in the URL (`(group)`, `@slot`).
 * The first segment must be a literal word. A pattern also matches
 * the paths below it (`/m/[joinRef]` covers `/m/X7K2/results`) and further into
 * a path (`/en/m/X7K2`, or the same route behind a `basePath`); a third-party
 * URL that happens to have the same shape is collapsed too, which only costs a
 * log line some detail.
 *
 * A malformed entry is skipped, not guessed at — `redact-path.test.ts` fails on
 * it and names the reason, so run the suite after editing. Full guide:
 * CUSTOMIZATION.md §4 · .context/logging/request-context.md.
 *
 * Boundary-clean: a plain string array (no imports), safe to import in the
 * proxy and the browser bundle.
 *
 * @example
 * ```ts
 * export const appCredentialPaths: readonly string[] = [
 *   '/possibilities/[publicRef]',
 *   '/m/[joinRef]',
 * ];
 * ```
 */
export const appCredentialPaths: readonly string[] = [];
