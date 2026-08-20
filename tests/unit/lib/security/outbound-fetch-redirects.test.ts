/**
 * Every server-side `fetch()` declares a redirect policy — or is exempt, in writing.
 *
 * ## Why this is a test and not a comment
 *
 * `lib/security/safe-url.ts` states the rule: *"Validation is per-URL, not
 * per-hop … Callers must either refuse redirects or re-run this check on each
 * hop."* #534 swept the callers guarding with `checkSafeProviderUrl` and missed
 * `lib/orchestration/http/fetch.ts`, which guards with an env host allowlist
 * instead — outside a grep scoped to the former. That was #628.
 *
 * The first attempt to stop it recurring was a hand-written roster of "the five
 * outbound-fetch sites" in `safe-url.ts`. Code review found the roster itself
 * was wrong by three. A list maintained by memory has exactly the failure mode
 * it was written to prevent, so this replaces it: the enumeration is mechanical,
 * and adding an outbound `fetch()` without a redirect policy fails CI.
 *
 * ## What counts
 *
 * A server-side `fetch(` in `lib/**` or `app/**` whose call expression does not
 * contain `redirect: '…'`. Client components are skipped — a browser fetch is
 * subject to the page's own origin rules, not to this module's guarantee.
 *
 * ## What it CANNOT see, and why that matters here
 *
 * **Outbound HTTP issued by an SDK, not by a literal `fetch(`.** This scans
 * source text for a call expression, so a vendor client that fetches internally
 * is invisible to it however it is configured. That is not hypothetical: it hid
 * the biggest site of the family until #635 went looking by hand.
 *
 * `lib/orchestration/llm/openai-compatible.ts` passes the admin-set
 * `AiProvider.baseUrl` into `new OpenAI({ baseURL })`, and that client carries
 * the prompt. The SDK sets no redirect policy and undici defaults to `follow`,
 * so every hop after the validated one received it. Neither #534's grep for
 * `checkSafeProviderUrl` callers nor this scan could see it.
 *
 * Both are guarded now, and guarded in a way this scan CAN see — the fix is a
 * `fetch` wrapper passed to the SDK, so the literal call appears here with its
 * policy on it. That is the shape to copy for any future SDK client: **give it
 * a wrapper rather than trusting its defaults.**
 *
 * But be precise about what that buys. This scan sees the wrapper only while
 * the wrapper exists: delete the `fetch:` option and the literal call goes with
 * it, and the file drops out of the scan **in silence**, exactly as before.
 * What actually pins the wiring is a per-client unit test —
 * `openai-compatible.test.ts` and `anthropic.test.ts` each assert that the
 * supplied `fetch` sets `redirect: 'error'`, and a passthrough fails them.
 *
 * `@anthropic-ai/sdk` needed the same fix and for a sharper reason. Its
 * constructor is called with no `baseURL`, which reads as "it can only reach
 * Anthropic" — and the SDK defaults `baseURL` to `readEnv('ANTHROPIC_BASE_URL')`,
 * so an operator pointing it at a gateway is one env var away. Anthropic also
 * authenticates with `x-api-key`, a custom header name the fetch spec does NOT
 * strip cross-origin, so a followed redirect would carry the key as well as the
 * prompt.
 *
 * The residual limit stands: a new SDK client configured with an operator-set
 * host and no wrapper would pass this file in silence. So read the heading
 * above as scoped to literal `fetch(` calls, not as "all outbound HTTP declares
 * a policy" — the hand-written roster this replaced made exactly that kind of
 * unbounded claim, which is how #628 happened.
 *
 * ## Adding a call site
 *
 * Set `redirect` explicitly. `'error'` for a configured integration (an endpoint
 * that moved should be re-pointed in config); `'manual'` plus a revalidating
 * loop when following is legitimate — see `fetchRevalidatingRedirects` in
 * `lib/orchestration/knowledge/url-fetcher.ts`. If neither applies, add a row
 * below with the reason, and expect to justify it in review.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { globSync } from 'tinyglobby';

/**
 * Files whose `fetch()` calls legitimately carry no redirect policy.
 *
 * `count` is the number of such calls in the file. It is pinned so that adding
 * an unguarded call to an already-exempt file still fails — a bare file-path
 * allowlist would silently absorb the next one.
 */
const EXEMPT: Record<string, { count: number; reason: string }> = {
  // Same-origin: these call Sunrise's own API, not an outbound host.
  'lib/api/client.ts': { count: 1, reason: 'browser → own API, same origin' },
  'lib/api/server-fetch.ts': { count: 1, reason: 'server → own API, same origin' },

  // Hardcoded literal host, not operator- or user-controlled, so there is no
  // "unvalidated second target" to reach: the first target is a constant.
  'lib/analytics/server.ts': {
    count: 3,
    reason: 'hardcoded https://www.google-analytics.com literal',
  },

  // Not server-side calls at all — these live inside a template literal that is
  // SERVED to the browser as the embed widget's source.
  'app/api/v1/embed/widget.js/route.ts': {
    count: 5,
    reason: 'client JS emitted as a response body, not executed here',
  },

  // The three KNOWN GAP rows that stood here were closed in #635. The table is
  // back to genuine exemptions only — nothing in it is now a deferred fix.
};

/** Text between the parens of the call starting at `openIdx`. */
function callRegion(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return '';
}

interface Site {
  file: string;
  line: number;
  redirect: string | null;
}

function findFetchSites(): Site[] {
  const files = globSync(['lib/**/*.ts', 'app/**/*.ts'], {
    cwd: process.cwd(),
    ignore: ['**/*.test.ts', '**/*.d.ts'],
  });

  const sites: Site[] = [];
  for (const rel of files.sort()) {
    const src = readFileSync(path.join(process.cwd(), rel), 'utf8');
    // A client component's fetch runs in the browser under the page's origin.
    if (/^\s*['"]use client['"]/m.test(src.slice(0, 200))) continue;

    for (const m of src.matchAll(/(?<![\w.$])fetch\s*\(/g)) {
      const idx = m.index;
      const lineStart = src.lastIndexOf('\n', idx) + 1;
      const lineText = src.slice(lineStart, src.indexOf('\n', idx));
      // Prose in a docblock or a `//` comment is not a call site.
      if (/^\s*(\*|\/\/)/.test(lineText)) continue;

      const region = callRegion(src, src.indexOf('(', idx));
      const redirect = /redirect:\s*'([a-z]+)'/.exec(region);
      sites.push({
        file: rel,
        line: src.slice(0, idx).split('\n').length,
        redirect: redirect ? redirect[1] : null,
      });
    }
  }
  return sites;
}

describe('outbound fetch redirect policy', () => {
  const sites = findFetchSites();

  it('finds the call sites at all — a scanner returning nothing would pass everything', () => {
    // The failure mode this guards is a refactor that breaks the regex and
    // turns the whole suite green by finding zero sites.
    expect(sites.length).toBeGreaterThan(10);
    expect(sites.some((s) => s.redirect === 'error')).toBe(true);
    expect(sites.some((s) => s.redirect === 'manual')).toBe(true);
  });

  it('every server-side fetch() sets a redirect policy or is a declared exemption', () => {
    const unguarded = sites.filter((s) => s.redirect === null);
    const undeclared = unguarded.filter((s) => !(s.file in EXEMPT));

    expect(
      undeclared.map((s) => `${s.file}:${s.line}`),
      'A server-side fetch() with no `redirect` option follows redirects by ' +
        'default (undici), so any per-URL validation upstream of it only ever ' +
        'sees the first hop — see lib/security/safe-url.ts. Set ' +
        "redirect: 'error', or follow-and-revalidate per hop, or add a row to " +
        'EXEMPT with the reason.'
    ).toEqual([]);
  });

  it('each exemption still matches the number of unguarded calls in that file', () => {
    // Pinned counts, so adding an unguarded fetch to an already-exempt file
    // fails rather than being absorbed by a bare path allowlist.
    const actual: Record<string, number> = {};
    for (const s of sites.filter((x) => x.redirect === null)) {
      actual[s.file] = (actual[s.file] ?? 0) + 1;
    }

    const drift = Object.entries(EXEMPT)
      .map(([file, { count }]) => ({ file, expected: count, found: actual[file] ?? 0 }))
      .filter((row) => row.expected !== row.found);

    expect(drift, 'EXEMPT count no longer matches the file — review the new call').toEqual([]);
  });
});
