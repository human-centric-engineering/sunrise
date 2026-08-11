/**
 * Tests for the lockfile diff rules.
 *
 * The headline case is `the 2026-07-29 metadata loss`, which reproduces the
 * shape of `d5b913fb` — a dependabot merge that took 77 packages' `libc` to
 * zero and shipped. See #571.
 *
 * @see scripts/ci/lockfile-diff.ts
 */

import { describe, it, expect } from 'vitest';

import {
  diffLockfiles,
  directDependencyKeys,
  hasRisk,
  isDowngrade,
  type Lockfile,
} from '@/scripts/ci/lockfile-diff';

/** A native Linux package as npm writes it, metadata intact. */
const NATIVE = {
  version: '1.0.3',
  os: ['linux'],
  cpu: ['x64'],
  libc: ['glibc'],
};

const BASE: Lockfile = {
  packages: {
    '': { version: '0.8.1' },
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/@napi-rs/canvas-linux-x64-gnu': NATIVE,
  },
};

/** Deep-ish clone so a test mutating its fixture cannot leak into the next. */
function clone(lock: Lockfile): Lockfile {
  return JSON.parse(JSON.stringify(lock)) as Lockfile;
}

describe('isDowngrade', () => {
  it.each([
    ['1.3.0', '1.2.9', true],
    ['2.0.0', '1.9.9', true],
    ['1.2.10', '1.2.9', true],
    ['1.2.9', '1.2.10', false],
    ['1.3.0', '1.3.0', false],
    ['1.3.0', '2.0.0', false],
  ])('%s → %s is downgrade=%s', (from, to, expected) => {
    // 1.2.10 → 1.2.9 is the one string comparison gets backwards.
    expect(isDowngrade(from, to)).toBe(expected);
  });

  it('does not call a prerelease or build suffix a downgrade', () => {
    // Ordering these properly is a job for a semver library; guessing would
    // produce false alarms on every package that uses them.
    expect(isDowngrade('1.3.0', '1.3.0-rc.1')).toBe(false);
    expect(isDowngrade('1.3.0-rc.1', '1.3.0')).toBe(false);
  });
});

describe('directDependencyKeys', () => {
  it('maps both dependency kinds to lockfile keys', () => {
    expect(
      directDependencyKeys({ dependencies: { next: '^16' }, devDependencies: { vitest: '^4' } })
    ).toEqual(new Set(['node_modules/next', 'node_modules/vitest']));
  });

  it('is empty for a manifest with neither', () => {
    expect(directDependencyKeys({})).toEqual(new Set());
  });
});

describe('diffLockfiles', () => {
  it('reports nothing for an unchanged lockfile', () => {
    const diff = diffLockfiles(BASE, clone(BASE));

    expect(diff).toEqual({
      added: [],
      removed: [],
      changed: [],
      lostNativeMetadata: [],
      overridesChanged: false,
    });
    expect(hasRisk(diff)).toBe(false);
  });

  it('names what was added and removed', () => {
    const head = clone(BASE);
    head.packages!['node_modules/right-pad'] = { version: '1.0.0' };
    delete head.packages!['node_modules/left-pad'];

    const diff = diffLockfiles(BASE, head);

    expect(diff.added).toEqual(['node_modules/right-pad']);
    expect(diff.removed).toEqual(['node_modules/left-pad']);
    // Neither is a decision on its own — every dependency PR moves packages.
    expect(hasRisk(diff)).toBe(false);
  });

  describe('the 2026-07-29 metadata loss', () => {
    // Reproduces d5b913fb: `libc` gone, `os` and `cpu` left behind. The
    // resulting lockfile installs fine on the maintainer's machine and cannot
    // tell a musl build from a glibc one on Alpine (#571).
    const head = (() => {
      const next = clone(BASE);
      delete next.packages!['node_modules/@napi-rs/canvas-linux-x64-gnu'].libc;
      return next;
    })();

    it('is caught, naming the package and the key', () => {
      const diff = diffLockfiles(BASE, head);

      expect(diff.lostNativeMetadata).toEqual([
        { name: 'node_modules/@napi-rs/canvas-linux-x64-gnu', keys: ['libc'] },
      ]);
      expect(hasRisk(diff)).toBe(true);
    });

    it('is invisible to a version comparison, which is why this rule exists', () => {
      // Nothing moved version. A check that only compared versions — the
      // obvious thing to write — would call this clean.
      expect(diffLockfiles(BASE, head).changed).toEqual([]);
    });
  });

  it('ignores metadata being gained', () => {
    // The ecosystem getting more precise is not the failure being guarded
    // against, and flagging it would fire on unrelated upgrades.
    const base = clone(BASE);
    delete base.packages!['node_modules/@napi-rs/canvas-linux-x64-gnu'].libc;

    const diff = diffLockfiles(base, BASE);

    expect(diff.lostNativeMetadata).toEqual([]);
    expect(hasRisk(diff)).toBe(false);
  });

  it('reports every lost key, not just the first', () => {
    const head = clone(BASE);
    const entry = head.packages!['node_modules/@napi-rs/canvas-linux-x64-gnu'];
    delete entry.libc;
    delete entry.cpu;

    expect(diffLockfiles(BASE, head).lostNativeMetadata[0].keys).toEqual(['cpu', 'libc']);
  });

  describe('downgrades', () => {
    const downgraded = (name: string): Lockfile => {
      const head = clone(BASE);
      head.packages![name] = { ...head.packages![name], version: '0.9.0' };
      return head;
    };

    it('gates a DIRECT dependency going backwards', () => {
      const diff = diffLockfiles(BASE, downgraded('node_modules/left-pad'), {
        directDependencies: new Set(['node_modules/left-pad']),
      });

      expect(diff.changed).toEqual([
        {
          name: 'node_modules/left-pad',
          from: '1.3.0',
          to: '0.9.0',
          downgrade: true,
          direct: true,
        },
      ]);
      expect(hasRisk(diff)).toBe(true);
    });

    it('reports but does not gate a TRANSITIVE one', () => {
      // Measured: 45 transitive downgrades against 2 direct across this repo's
      // history, clustering in commits like "pin Prisma to ~7.1.0" where one
      // intended pin drags its subtree back. Gating would cry wolf.
      const diff = diffLockfiles(BASE, downgraded('node_modules/left-pad'), {});

      expect(diff.changed[0]).toMatchObject({ downgrade: true, direct: false });
      expect(hasRisk(diff)).toBe(false);
    });

    it('does not treat an upgrade as a downgrade', () => {
      const head = clone(BASE);
      head.packages!['node_modules/left-pad'] = { version: '1.4.0' };

      const diff = diffLockfiles(BASE, head, {
        directDependencies: new Set(['node_modules/left-pad']),
      });

      expect(diff.changed[0]).toMatchObject({ downgrade: false });
      expect(hasRisk(diff)).toBe(false);
    });
  });

  describe('overrides', () => {
    // Read from `package.json`, never the lockfile: the word does not appear in
    // `package-lock.json` at all. The earlier fixtures put it at the lockfile
    // root, so they were green against a rule that could never fire.
    it('gates a changed value', () => {
      const diff = diffLockfiles(BASE, clone(BASE), {
        baseOverrides: { hono: '^4.11.7' },
        headOverrides: { hono: '^5.0.0' },
      });

      expect(hasRisk(diff)).toBe(true);
    });

    it('gates a newly added override', () => {
      expect(
        hasRisk(diffLockfiles(BASE, clone(BASE), { headOverrides: { valibot: '^1.2.0' } }))
      ).toBe(true);
    });

    it('does not fire when they are merely present and unchanged', () => {
      // Sunrise carries two deliberately; their existence is not a finding.
      const both = { hono: '^4.11.7', valibot: '^1.2.0' };

      expect(
        hasRisk(diffLockfiles(BASE, clone(BASE), { baseOverrides: both, headOverrides: both }))
      ).toBe(false);
    });

    it('ignores `overrides` sitting on the lockfile, where npm never puts it', () => {
      // Guards the old bug from coming back by the same route.
      const withStray = { ...clone(BASE), overrides: { hono: '^9' } } as typeof BASE;

      expect(hasRisk(diffLockfiles(BASE, withStray))).toBe(false);
    });
  });

  it('tolerates a lockfile with no packages at all', () => {
    expect(diffLockfiles({}, {})).toMatchObject({ added: [], removed: [], changed: [] });
  });
});
