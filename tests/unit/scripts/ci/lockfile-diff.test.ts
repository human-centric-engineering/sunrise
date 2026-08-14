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
  directDowngrades,
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

  it('counts optional and peer dependencies too', () => {
    // A fork with either would have had a downgrade there classified
    // transitive and never gated — the case the rule exists for.
    expect(
      directDependencyKeys({
        optionalDependencies: { sharp: '^0.34' },
        peerDependencies: { react: '^19' },
      })
    ).toEqual(new Set(['node_modules/sharp', 'node_modules/react']));
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
      gainedNativeMetadata: [],
      overridesChanged: false,
      overrideChanges: [],
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

  describe('across a hoist', () => {
    // `npm update` — the operation this rule exists to catch — both
    // restructures the tree and strips metadata. A package moving from
    // `node_modules/a/node_modules/foo` to `node_modules/foo` is a remove plus
    // an add, so a same-key comparison never sees it. This lockfile has 77
    // native-metadata entries at nested paths.
    const nested: Lockfile = {
      packages: {
        'node_modules/pdf/node_modules/canvas-linux-x64': { ...NATIVE },
      },
    };

    it('catches metadata lost while the package moved', () => {
      const hoistedAndStripped: Lockfile = {
        packages: {
          'node_modules/canvas-linux-x64': { version: '1.0.3', os: ['linux'], cpu: ['x64'] },
        },
      };

      const diff = diffLockfiles(nested, hoistedAndStripped);

      expect(diff.lostNativeMetadata).toEqual([
        { name: 'node_modules/pdf/node_modules/canvas-linux-x64', keys: ['libc'] },
      ]);
      expect(hasRisk(diff)).toBe(true);
    });

    it('does not fire when the moved copy kept its metadata', () => {
      const hoistedIntact: Lockfile = {
        packages: { 'node_modules/canvas-linux-x64': { ...NATIVE } },
      };

      expect(diffLockfiles(nested, hoistedIntact).lostNativeMetadata).toEqual([]);
    });

    it('does not fire when the package was genuinely removed', () => {
      // Nothing by that name survives, so there is no loss to report — the
      // dependency simply went away.
      expect(diffLockfiles(nested, { packages: {} }).lostNativeMetadata).toEqual([]);
    });

    it('does not fire when any surviving copy still has the key', () => {
      const twoCopies: Lockfile = {
        packages: {
          'node_modules/canvas-linux-x64': { version: '1.0.3', os: ['linux'] },
          'node_modules/other/node_modules/canvas-linux-x64': { ...NATIVE },
        },
      };

      expect(diffLockfiles(nested, twoCopies).lostNativeMetadata).toEqual([]);
    });

    it('does not fire when a duplicate is deduped away and the survivor predates it', () => {
      // The false positive this guard exists for, taken from a real run: a
      // `react-email` bump deleted the whole nested `@react-email/ui` subtree,
      // including a copy of `@img/sharp-wasm32` that declared `cpu`. A
      // top-level copy of the same package survived — but it was already there
      // before, unchanged, and had never declared `cpu`.
      //
      // Nothing moved and nothing was stripped: a duplicate went away. Matching
      // the removed path against a pre-existing survivor reported it as a
      // hoist-with-loss and sent two people reading lockfile diffs (#583/#589).
      // A hoist means the surviving path is NEW; if every survivor predates the
      // removal, this is a deduplication.
      const bothCopies: Lockfile = {
        packages: {
          'node_modules/sharp-wasm32': { version: '0.35.3' },
          'node_modules/ui/node_modules/sharp-wasm32': { version: '0.34.5', cpu: ['wasm32'] },
        },
      };
      const dedupedToTheExistingCopy: Lockfile = {
        packages: { 'node_modules/sharp-wasm32': { version: '0.35.3' } },
      };

      const diff = diffLockfiles(bothCopies, dedupedToTheExistingCopy);

      expect(diff.lostNativeMetadata).toEqual([]);
      expect(hasRisk(diff)).toBe(false);
      // Still reported as removed — the tree did change, it just lost nothing.
      expect(diff.removed).toContain('node_modules/ui/node_modules/sharp-wasm32');
    });

    it('still fires on a hoist AND upgrade in one operation', () => {
      // `npm update` does both at once, which is why the header calls it the
      // operation this rule exists to catch. Keying the dedup guard on the
      // version alone skipped it — the upgraded copy is at a new path with a
      // new version, so no same-version survivor exists — and the same-path
      // loop never sees it either, because the path changed. The loss was
      // invisible in every field of the diff.
      const base: Lockfile = {
        packages: {
          'node_modules/pdf/node_modules/sharp-linux-x64': {
            version: '0.33.5',
            os: ['linux'],
            cpu: ['x64'],
            libc: ['musl'],
          },
        },
      };
      const hoistedUpgradedStripped: Lockfile = {
        packages: {
          'node_modules/sharp-linux-x64': { version: '0.34.0', os: ['linux'], cpu: ['x64'] },
        },
      };

      const diff = diffLockfiles(base, hoistedUpgradedStripped);

      expect(diff.lostNativeMetadata).toEqual([
        { name: 'node_modules/pdf/node_modules/sharp-linux-x64', keys: ['libc'] },
      ]);
      expect(hasRisk(diff)).toBe(true);
    });

    it('still fires when the SAME version is deduped into an un-annotated copy', () => {
      // The dedup guard must key on the removed *resolution*, not on its path
      // having pre-existed. Here 1.0.0 was in the tree twice with `libc` and
      // once without; after the dedupe it is in the tree only without. That is
      // a genuine loss of platform filtering for whatever resolved to the
      // nested copies — the #571 failure mode exactly — and a path-membership
      // guard silently skips it.
      const partiallyAnnotated: Lockfile = {
        packages: {
          'node_modules/foo': { version: '1.0.0' },
          'node_modules/a/node_modules/foo': { version: '1.0.0', libc: ['musl'] },
          'node_modules/b/node_modules/foo': { version: '1.0.0', libc: ['musl'] },
        },
      };
      const dedupedToTheUnannotatedCopy: Lockfile = {
        packages: { 'node_modules/foo': { version: '1.0.0' } },
      };

      const diff = diffLockfiles(partiallyAnnotated, dedupedToTheUnannotatedCopy);

      expect(diff.lostNativeMetadata).toEqual([
        { name: 'node_modules/a/node_modules/foo', keys: ['libc'] },
        { name: 'node_modules/b/node_modules/foo', keys: ['libc'] },
      ]);
      expect(hasRisk(diff)).toBe(true);
    });

    it('still fires when a hoist upgrades into a pre-existing un-annotated path', () => {
      // `npm update` under npm < 11.11.0: the top-level entry is rewritten to
      // the nested copy's version and loses `libc` on the way. The surviving
      // path pre-existed, so path-membership suppresses it — but the version
      // that only ever existed WITH libc is now in the tree WITHOUT it.
      const before: Lockfile = {
        packages: {
          'node_modules/sharp-linux-x64': { version: '0.33.0', os: ['linux'], cpu: ['x64'] },
          'node_modules/pdfkit/node_modules/sharp-linux-x64': {
            version: '0.34.0',
            os: ['linux'],
            cpu: ['x64'],
            libc: ['musl'],
          },
        },
      };
      const after: Lockfile = {
        packages: {
          'node_modules/sharp-linux-x64': { version: '0.34.0', os: ['linux'], cpu: ['x64'] },
        },
      };

      const diff = diffLockfiles(before, after);

      expect(diff.lostNativeMetadata).toEqual([
        { name: 'node_modules/pdfkit/node_modules/sharp-linux-x64', keys: ['libc'] },
      ]);
      expect(hasRisk(diff)).toBe(true);
    });

    it('still fires when the survivor is new, even alongside an untouched copy', () => {
      // Guards the fix from over-correcting: one survivor predates the move and
      // one is new. A genuine hoist is hiding in here and must still be caught.
      const before: Lockfile = {
        packages: {
          'node_modules/keeper/node_modules/canvas-linux-x64': { version: '1.0.3' },
          'node_modules/pdf/node_modules/canvas-linux-x64': { ...NATIVE },
        },
      };
      const after: Lockfile = {
        packages: {
          'node_modules/keeper/node_modules/canvas-linux-x64': { version: '1.0.3' },
          'node_modules/canvas-linux-x64': { version: '1.0.3', os: ['linux'], cpu: ['x64'] },
        },
      };

      expect(diffLockfiles(before, after).lostNativeMetadata).toEqual([
        { name: 'node_modules/pdf/node_modules/canvas-linux-x64', keys: ['libc'] },
      ]);
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
    // Reported, though — the #571 repair was 101 packages gaining `libc` and
    // nothing else, and this tool called that "no platform-metadata change".
    expect(diff.gainedNativeMetadata).toEqual([
      { name: 'node_modules/@napi-rs/canvas-linux-x64-gnu', keys: ['libc'] },
    ]);
  });

  it('reports every gained key, not just the first', () => {
    const base = clone(BASE);
    const entry = base.packages!['node_modules/@napi-rs/canvas-linux-x64-gnu'];
    delete entry.libc;
    delete entry.cpu;

    expect(diffLockfiles(base, BASE).gainedNativeMetadata[0].keys).toEqual(['cpu', 'libc']);
  });

  it('does not report a gain for a brand-new package', () => {
    // Every added native package would otherwise read as "gained metadata",
    // which is noise on any ordinary dependency addition.
    const head = clone(BASE);
    head.packages!['node_modules/brand-new'] = {
      version: '1.0.0',
      os: ['linux'],
      libc: ['musl'],
    };

    expect(diffLockfiles(BASE, head).gainedNativeMetadata).toEqual([]);
  });

  it('does not gate on a gain', () => {
    const base = clone(BASE);
    delete base.packages!['node_modules/@napi-rs/canvas-linux-x64-gnu'].libc;

    expect(hasRisk(diffLockfiles(base, BASE))).toBe(false);
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

    it('CLASSIFIES a direct downgrade but no longer gates on it', () => {
      // The classification is what the report is built from and must stay
      // exact. The gating changed: over 134 lockfile commits the rule fired
      // twice, on two deliberate pins, while `dependency-review` measures the
      // real risk — a KNOWN-vulnerable version — on every public PR.
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
      expect(directDowngrades(diff)).toHaveLength(1);
      expect(hasRisk(diff)).toBe(false);
    });

    it('STILL gates lost platform metadata when a direct downgrade is present', () => {
      // The relaxation must not leak into the rule that actually shipped
      // broken (#571).
      const head = downgraded('node_modules/left-pad');
      delete head.packages!['node_modules/@napi-rs/canvas-linux-x64-gnu'].libc;

      const diff = diffLockfiles(BASE, head, {
        directDependencies: new Set(['node_modules/left-pad']),
      });

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

    it('is not fooled by key order', () => {
      // Alphabetising `overrides` in package.json is not a semantic change and
      // must not be answered with "Intentional?".
      const diff = diffLockfiles(BASE, clone(BASE), {
        baseOverrides: { hono: '^4.11.7', valibot: '^1.2.0' },
        headOverrides: { valibot: '^1.2.0', hono: '^4.11.7' },
      });

      expect(hasRisk(diff)).toBe(false);
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
