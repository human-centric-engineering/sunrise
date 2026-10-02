/**
 * Unit Tests: the browser-tab icons are on the App Router file convention (#640)
 *
 * Sunrise used to ship `public/favicon.ico` and `public/favicon.svg`. Nothing
 * linked the SVG — the root `metadata` declared no `icons` and `app/` had no
 * `icon.*` file — so every app served only the raster ICO, found by the
 * browser's root-path guess. Rebranding the tab then meant writing an `icons`
 * block into `app/layout.tsx`, a platform-owned file.
 *
 * The icons now live at `app/favicon.ico` and `app/icon.svg`, which Next links
 * from `<head>` on its own. A fork rebrands by replacing those two files and
 * edits nothing else. These rows pin that, and the two ways it quietly breaks:
 * an icon left behind in `public/`, and a proxy matcher that stops exempting
 * the icon routes.
 *
 * FORK NOTE — replace the two files freely. The icon may be any static
 * `app/icon.{svg,png,ico,jpg,jpeg}`; `app/favicon.ico` must stay an ICO. Do not
 * move them back to `public/`. A code-generated `app/icon.tsx` is NOT covered:
 * it is served at the extensionless `/icon`, which the proxy matcher does not
 * skip.
 *
 * @see app/favicon.ico · app/icon.svg · proxy.ts (config.matcher)
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAppPageStaticInfo } from 'next/dist/build/analysis/get-page-static-info';
import { loadBindings } from 'next/dist/build/swc';
import type { PAGE_TYPES } from 'next/dist/lib/page-types';

const root = process.cwd();

/** Static image extensions Next accepts for `app/icon.*`. */
const ICON_EXTENSIONS = ['svg', 'png', 'ico', 'jpg', 'jpeg'] as const;

/** The static `app/icon.*` files present, repo-relative. */
const appIcons = (): string[] =>
  ICON_EXTENSIONS.map((ext) => `app/icon.${ext}`).filter((p) => existsSync(join(root, p)));

describe('app icons use the App Router file convention', () => {
  it('ships app/favicon.ico as a real ICO file', () => {
    const path = join(root, 'app/favicon.ico');
    expect(existsSync(path), 'app/favicon.ico is missing').toBe(true);
    // ICONDIR header: reserved 0, type 1 (icon).
    const header = readFileSync(path).subarray(0, 4);
    expect([...header]).toEqual([0, 0, 1, 0]);
  });

  it('ships a static app/icon.* so Next links an icon beside the ICO', () => {
    const icons = appIcons();
    expect(
      icons,
      `no static app/icon.{${ICON_EXTENSIONS.join(',')}} — Sunrise ships app/icon.svg`
    ).not.toEqual([]);
    // An SVG must actually be one, or the browser drops it and falls back to the ICO.
    for (const icon of icons.filter((p) => p.endsWith('.svg')))
      expect(readFileSync(join(root, icon), 'utf8'), icon).toMatch(/<svg[\s>]/);
  });

  it('leaves no favicon in public/ to shadow or conflict with the app/ files', () => {
    // public/favicon.ico alongside app/favicon.ico is a dev-server 500 ("A
    // conflicting public file and page file was found"). public/favicon.svg is
    // linked by nothing, which is the defect #640 was filed about.
    const leftovers = ['public/favicon.ico', 'public/favicon.svg'].filter((p) =>
      existsSync(join(root, p))
    );
    expect(
      leftovers,
      'Move your icon to app/favicon.ico or app/icon.svg instead — Next links those automatically.'
    ).toEqual([]);
  });

  it('the proxy matcher skips the icon routes', async () => {
    // Static app icons are served at /favicon.ico and /icon.<ext> (the link adds
    // a ?<hash> query, which the matcher never sees). A matcher that ran the
    // proxy on them would add a session lookup to every tab-icon fetch.
    //
    // The matcher is read the way `next build` reads it: parsed out of the
    // proxy.ts SOURCE and compiled with Next's own path-to-regexp handling. So
    // this neither executes proxy.ts (and everything it imports) nor guesses at
    // how Next interprets the pattern. If Next moves these internals, the import
    // fails loudly; it cannot pass silently.
    await loadBindings();
    const info = await getAppPageStaticInfo({
      pageFilePath: join(root, 'proxy.ts'),
      nextConfig: {},
      isDev: false,
      page: '/proxy',
      // A const enum, which isolatedModules cannot import as a value.
      pageType: 'app' as PAGE_TYPES,
    });
    const matchers = info.middleware?.matchers ?? [];
    expect(matchers.length, 'Next found no config.matcher in proxy.ts').toBeGreaterThan(0);
    const runs = (path: string): boolean => matchers.some((m) => new RegExp(m.regexp).test(path));

    // CONTROL: the matcher still matches an ordinary page, so a `false` below
    // means "exempted", not "the matcher matches nothing".
    expect(runs('/dashboard')).toBe(true);
    expect(runs('/favicon.ico')).toBe(false);
    for (const icon of appIcons()) expect(runs(`/${icon.slice('app/'.length)}`), icon).toBe(false);
  });
});
