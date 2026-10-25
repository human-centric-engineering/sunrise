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

import {
  APP_DIR,
  OWN_MODULES_FILE,
  ownModuleProblems,
  scaffoldSourceFiles,
  scaffoldsOnDisk,
  unlistedSeams,
} from '@/tests/helpers/app-scaffolds';

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

  describe('unlistedSeams', () => {
    // Every guard that demands a row per seam asks through this one function,
    // so a fork's declared modules are skipped by all of them (#847).
    it('owes a row for every scaffold the list does not name', () => {
      expect(unlistedSeams(['lib/app/brand.ts'], dir, [])).toEqual([
        'lib/app/orders/',
        'lib/app/theme.mts',
      ]);
    });

    it("skips a fork's own modules, a directory and a file alike", () => {
      expect(
        unlistedSeams(['lib/app/brand.ts'], dir, ['lib/app/orders/', 'lib/app/theme.mts'])
      ).toEqual([]);
    });

    it('still owes a row for a seam the fork did not declare', () => {
      expect(unlistedSeams([], dir, ['lib/app/orders/'])).toEqual([
        'lib/app/brand.ts',
        'lib/app/theme.mts',
      ]);
    });
  });

  describe('ownModuleProblems', () => {
    const onDisk = ['lib/app/brand.ts', 'lib/app/orders/', 'lib/app/theme.mts', OWN_MODULES_FILE];
    const rowsIn = {
      'VERSIONING.md': ['lib/app/brand.ts', OWN_MODULES_FILE],
      'CUSTOMIZATION.md §4': ['lib/app/brand.ts', 'lib/app/theme.mts'],
    };

    it('accepts a module on disk that no list has a row for', () => {
      expect(ownModuleProblems(['lib/app/orders/'], onDisk, rowsIn)).toEqual([]);
    });

    it('refuses an entry once per list that still has a row for it', () => {
      expect(ownModuleProblems(['lib/app/brand.ts'], onDisk, rowsIn)).toEqual([
        expect.stringContaining('lib/app/brand.ts: VERSIONING.md still has a row'),
        expect.stringContaining('lib/app/brand.ts: CUSTOMIZATION.md §4 still has a row'),
      ]);
    });

    it('refuses a module whose old row survives in only one list', () => {
      // The fork deleted the VERSIONING.md row but not the CUSTOMIZATION.md one.
      expect(ownModuleProblems(['lib/app/theme.mts'], onDisk, rowsIn)).toEqual([
        expect.stringContaining('CUSTOMIZATION.md §4 still has a row'),
      ]);
    });

    it('refuses the declaration file itself', () => {
      expect(ownModuleProblems([OWN_MODULES_FILE], onDisk, rowsIn)).toEqual([
        expect.stringContaining('the declaration file is a seam'),
      ]);
    });

    it.each(['lib/app/types.d.ts', 'lib/app/README.md', 'lib/app/.helpers/'])(
      'says %s is already not a seam, rather than that it is missing',
      (entry) => {
        expect(ownModuleProblems([entry], onDisk, rowsIn)).toEqual([
          expect.stringContaining('already not a seam (NOT_A_SEAM)'),
        ]);
      }
    );

    it.each([
      ['a directory without its trailing slash', 'lib/app/orders'],
      ['a file given a trailing slash', 'lib/app/theme.mts/'],
      ['an entry that is not on disk', 'lib/app/pricing.ts'],
    ])('refuses %s', (_label, entry) => {
      expect(ownModuleProblems([entry], onDisk, rowsIn)).toEqual([
        expect.stringContaining(`${entry}: not in lib/app/`),
      ]);
    });

    it.each(['orders/', 'lib/app/orders/server/', 'lib/framework/x.ts'])(
      'refuses %s, which is not lib/app/<file> or lib/app/<dir>/',
      (entry) => {
        expect(ownModuleProblems([entry], onDisk, rowsIn)).toEqual([
          expect.stringContaining('not lib/app/<file> or lib/app/<dir>/'),
        ]);
      }
    );
  });
});
