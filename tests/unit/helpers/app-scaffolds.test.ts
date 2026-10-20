/**
 * The shared `lib/app/` scaffold rule (#734).
 *
 * Driven against a temporary fixture directory, because the shapes that broke
 * the three guards' agreement — a nested seam directory and an unfamiliar
 * extension — do not exist upstream: `lib/app/` is flat and all `.ts` plus one
 * `.mjs`. Against the real tree these assertions could only pass.
 *
 * @see tests/helpers/app-scaffolds.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_DIR, scaffoldSourceFiles, scaffoldsOnDisk } from '@/tests/helpers/app-scaffolds';

describe('app scaffolds', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'app-scaffolds-'));
    const write = (rel: string, body = '') => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), body);
    };
    write('brand.ts', 'export const appBrandName = null;\n');
    write('theme.mts', 'export function initAppTheme() {}\n');
    write('orders/server/index.ts', 'export function initAppOrders() {}\n');
    write('orders/server/types.d.ts');
    write('orders/README.md');
    write('types.d.ts');
    write('README.md');
    write('.gitkeep');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('counts a nested directory as one scaffold and an unfamiliar extension as another', () => {
    expect(scaffoldsOnDisk(dir)).toEqual([
      'lib/app/brand.ts',
      'lib/app/orders/',
      'lib/app/theme.mts',
    ]);
  });

  it('hands the guards every file inside a nested seam, not only top-level .ts files', () => {
    // fork-init-seams scanned `readdirSync(lib/app)` for `.ts` names, so both
    // `initAppTheme` (in a .mts) and `initAppOrders` (two levels down) were
    // invisible to it while the VERSIONING guard demanded rows for them.
    const rel = scaffoldSourceFiles(dir).map((f) => path.relative(dir, f));

    expect(rel).toEqual(['brand.ts', 'orders/server/index.ts', 'theme.mts']);
  });

  it('reads the real lib/app/ by default', () => {
    // Population check, so the fixture tests above are not the only evidence:
    // the default directory is the real one and it is not empty.
    expect(APP_DIR).toBe(path.join(process.cwd(), 'lib/app'));
    expect(scaffoldsOnDisk()).toContain('lib/app/bootstrap.ts');
    expect(scaffoldsOnDisk()).toContain('lib/app/eslint.config.mjs');
  });
});
