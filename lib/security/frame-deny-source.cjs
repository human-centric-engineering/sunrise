/**
 * The `source` of `next.config.js`'s blanket `X-Frame-Options: DENY` rule
 * (#887): every path, less the prefixes a fork lists in
 * `lib/app/frameable-paths.json` (fork-owned, ships `[]`).
 *
 * Why a list at all: a header `next.config.js` adds is sent alongside the
 * proxy's and cannot be removed per request, and a `has`/`missing` condition on
 * a header the proxy sets cannot switch it off either — `next.config` headers
 * match the browser's original request, not the one the proxy rewrites, and a
 * client could send that header itself. So the rule has to leave the framable
 * prefixes out by path. On those prefixes `proxy.ts` sets the framing headers
 * itself: `DENY` and `frame-ancestors 'none'`, unless the fork's
 * `lib/app/frame-ancestors.ts` names sites for that request.
 *
 * Only plain `/segment/` prefixes are accepted (lowercase letters, digits and
 * hyphens, one segment, leading and trailing slash). Anything else is ignored,
 * so a typo cannot open the whole app or inject into the pattern. An empty or
 * entirely invalid list returns `'/(.*)'`, the rule as it always was.
 *
 * CommonJS, and not under `lib/app/`, because `next.config.js` requires it
 * before any build step runs; it is platform code with a test of its own.
 *
 * @param {unknown} listed - the parsed contents of `lib/app/frameable-paths.json`
 * @returns {string} a path-to-regexp `source` for the DENY rule
 */
function frameDenySource(listed) {
  const prefixes = (Array.isArray(listed) ? listed : [])
    .filter((prefix) => typeof prefix === 'string' && /^\/[a-z0-9-]+\/$/.test(prefix))
    .map((prefix) => prefix.slice(1));
  const unique = [...new Set(prefixes)];
  return unique.length === 0 ? '/(.*)' : `/((?!${unique.join('|')}).*)`;
}

module.exports = { frameDenySource };
