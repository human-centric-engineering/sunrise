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
 * FORK NOTE — replace the two files' CONTENTS freely; every row here passes
 * with any valid ICO and SVG. Do not move them back to `public/`.
 *
 * @see app/favicon.ico · app/icon.svg · proxy.ts (config.matcher)
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@/proxy';

const root = process.cwd();

describe('app icons use the App Router file convention', () => {
  it('ships app/favicon.ico as a real ICO file', () => {
    const path = join(root, 'app/favicon.ico');
    expect(existsSync(path), 'app/favicon.ico is missing').toBe(true);
    // ICONDIR header: reserved 0, type 1 (icon).
    const header = readFileSync(path).subarray(0, 4);
    expect([...header]).toEqual([0, 0, 1, 0]);
  });

  it('ships app/icon.svg as an SVG, so the vector icon is linked', () => {
    const path = join(root, 'app/icon.svg');
    expect(existsSync(path), 'app/icon.svg is missing').toBe(true);
    expect(readFileSync(path, 'utf8')).toMatch(/<svg[\s>]/);
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

  it('the proxy matcher skips the icon routes', () => {
    // Static app icons are served at /favicon.ico and /icon.svg (the link adds
    // a ?<hash> query, which the matcher never sees). A matcher that ran the
    // proxy on them would add a session lookup to every tab-icon fetch.
    const matchers = [config.matcher].flat();
    const runs = (path: string): boolean => matchers.some((m) => new RegExp(`^${m}$`).test(path));

    // CONTROL: the matcher still matches an ordinary page, so a `false` below
    // means "exempted", not "the matcher is unreadable as a regex".
    expect(runs('/dashboard')).toBe(true);
    expect(runs('/favicon.ico')).toBe(false);
    expect(runs('/icon.svg')).toBe(false);
  });
});
