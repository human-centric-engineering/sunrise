/**
 * Tests for the `libc` restoration rules.
 *
 * The load-bearing one is `withLibc` placement: the field has to land exactly
 * where npm's serialiser would put it, or the next write by a current npm
 * reorders it and every native package churns. The fixtures for that are real
 * entries copied out of `d5b913fb^:package-lock.json` — the last lockfile a
 * modern npm wrote — rather than shapes invented here, because the whole
 * question is what npm actually does.
 *
 * @see scripts/ci/lockfile-libc.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  applyLibc,
  entryName,
  isValidPackageName,
  libcCandidates,
  linuxWithoutLibc,
  normaliseLibc,
  withLibc,
  type LibcLockfile,
} from '@/scripts/ci/lockfile-libc';

const REG = 'https://registry.npmjs.org/';

describe('entryName', () => {
  it('reads the deepest node_modules segment', () => {
    expect(entryName('node_modules/a/node_modules/@img/sharp-linux-x64', {})).toBe(
      '@img/sharp-linux-x64'
    );
  });

  it('prefers the alias target over the install path', () => {
    // `"foo": "npm:bar@1"` writes the path into the key; asking the registry
    // for `foo` would 404 and leave the package silently bare.
    expect(entryName('node_modules/foo', { name: 'bar' })).toBe('bar');
  });

  it('returns null for a key with no node_modules segment', () => {
    expect(entryName('packages/workspace-a', {})).toBeNull();
  });

  it('returns null rather than an empty name for a trailing separator', () => {
    expect(entryName('node_modules/', {})).toBeNull();
  });
});

describe('normaliseLibc', () => {
  it('wraps the bare-string manifest form npm normalises to an array', () => {
    expect(normaliseLibc('musl')).toEqual(['musl']);
  });

  it('passes an array through', () => {
    expect(normaliseLibc(['glibc'])).toEqual(['glibc']);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty array', []],
    ['an empty string', ''],
    ['a non-string member', [1]],
  ])('treats %s as absent', (_label, input) => {
    expect(normaliseLibc(input)).toBeNull();
  });

  it('does not write an empty libc, which would exclude the package everywhere', () => {
    expect(normaliseLibc([''])).toBeNull();
  });
});

describe('withLibc placement', () => {
  it('places libc after cpu when there is no dev flag', () => {
    // Real shape: node_modules/@rollup/rollup-linux-x64-musl
    const entry = {
      version: '4.62.4',
      resolved: `${REG}@rollup/rollup-linux-x64-musl/-/x.tgz`,
      integrity: 'sha512-x',
      cpu: ['x64'],
      license: 'MIT',
      optional: true,
      os: ['linux'],
    };
    expect(Object.keys(withLibc(entry, ['musl']))).toEqual([
      'version',
      'resolved',
      'integrity',
      'cpu',
      'libc',
      'license',
      'optional',
      'os',
    ]);
  });

  it('places libc after dev, not immediately after cpu', () => {
    // npm sorts non-preferred keys alphabetically, so `dev` precedes `libc`.
    // Placing it right after `cpu` is the plausible-looking wrong answer and
    // it churned 26 of the 77 real entries.
    const entry = {
      version: '4.3.3',
      resolved: `${REG}@tailwindcss/oxide-linux-x64-musl/-/x.tgz`,
      integrity: 'sha512-x',
      cpu: ['x64'],
      dev: true,
      license: 'MIT',
      optional: true,
      os: ['linux'],
      engines: { node: '>= 10' },
    };
    expect(Object.keys(withLibc(entry, ['musl']))).toEqual([
      'version',
      'resolved',
      'integrity',
      'cpu',
      'dev',
      'libc',
      'license',
      'optional',
      'os',
      'engines',
    ]);
  });

  it('places libc before an object-valued key that sorts earlier alphabetically', () => {
    // `engines` < `libc` alphabetically, but objects sort last, so libc wins.
    const entry = { version: '1.0.0', cpu: ['x64'], engines: { node: '>=18' } };
    expect(Object.keys(withLibc(entry, ['glibc']))).toEqual(['version', 'cpu', 'libc', 'engines']);
  });

  it('treats arrays as scalars, so os sorts after libc', () => {
    const entry = { version: '1.0.0', os: ['linux'] };
    expect(Object.keys(withLibc(entry, ['musl']))).toEqual(['version', 'libc', 'os']);
  });

  it('appends when every other key sorts before libc', () => {
    const entry = { version: '1.0.0', cpu: ['x64'], integrity: 'sha512-x' };
    expect(Object.keys(withLibc(entry, ['musl']))).toEqual(['version', 'cpu', 'integrity', 'libc']);
  });

  it('does not mutate the entry it was given', () => {
    const entry = { version: '1.0.0', os: ['linux'] };
    withLibc(entry, ['musl']);
    expect(entry).not.toHaveProperty('libc');
  });

  it('places libc before dependencies — a preferred key that is an object', () => {
    // npm's comparator checks object-ness BEFORE the preferred-key list, so
    // every scalar precedes every object including `dependencies` (preferred,
    // index 7). Gating the object test on `!SW_KEY_ORDER.has(key)` skipped
    // `dependencies` as an insertion point and appended libc after it.
    const entry = {
      version: '1.0.0',
      resolved: `${REG}x/-/x.tgz`,
      integrity: 'sha512-x',
      cpu: ['x64'],
      dependencies: { foo: '^1' },
    };
    expect(Object.keys(withLibc(entry, ['musl']))).toEqual([
      'version',
      'resolved',
      'integrity',
      'cpu',
      'libc',
      'dependencies',
    ]);
  });

  it('ignores preferred keys when choosing a position', () => {
    // `integrity` and `resolved` sort after `libc` but are written first by
    // npm, so they must not pull libc up in front of them.
    const entry = { version: '1.0.0', resolved: `${REG}x/-/x.tgz`, integrity: 'sha512-x' };
    expect(Object.keys(withLibc(entry, ['musl']))).toEqual([
      'version',
      'resolved',
      'integrity',
      'libc',
    ]);
  });
});

describe('libcCandidates', () => {
  const lock: LibcLockfile = {
    packages: {
      '': { version: '0.9.0' },
      'node_modules/normal': { version: '1.0.0', resolved: `${REG}normal/-/x.tgz` },
      'node_modules/linked': { link: true, resolved: `${REG}linked/-/x.tgz`, version: '1.0.0' },
      'node_modules/git-dep': {
        version: '1.0.0',
        resolved: 'git+ssh://git@github.com/o/r.git#abc',
      },
      'node_modules/private': {
        version: '1.0.0',
        resolved: 'https://npm.internal.example/private/-/x.tgz',
      },
      'node_modules/no-version': { resolved: `${REG}no-version/-/x.tgz` },
    },
  };

  it('keeps only registry-resolved, versioned, non-link entries', () => {
    expect(libcCandidates(lock).map((c) => c.key)).toEqual(['node_modules/normal']);
  });

  it('does not query a private registry', () => {
    expect(libcCandidates(lock).some((c) => c.name === 'private')).toBe(false);
  });

  it('tolerates a lockfile with no packages block', () => {
    expect(libcCandidates({})).toEqual([]);
  });
});

describe('applyLibc', () => {
  const lock: LibcLockfile = {
    lockfileVersion: 3,
    packages: {
      '': { version: '0.9.0' },
      'node_modules/musl-pkg': {
        version: '1.0.0',
        resolved: `${REG}musl-pkg/-/x.tgz`,
        cpu: ['x64'],
        os: ['linux'],
      },
      'node_modules/plain': { version: '2.0.0', resolved: `${REG}plain/-/x.tgz` },
    },
  };
  const lookup = (name: string): unknown => (name === 'musl-pkg' ? 'musl' : undefined);

  it('restores the declared libc and reports it', () => {
    const repair = applyLibc(lock, lookup);
    expect(repair.added).toEqual([{ key: 'node_modules/musl-pkg', libc: ['musl'] }]);
    expect(repair.lockfile.packages?.['node_modules/musl-pkg'].libc).toEqual(['musl']);
  });

  it('leaves packages the registry declares nothing for alone', () => {
    expect(applyLibc(lock, lookup).lockfile.packages?.['node_modules/plain']).not.toHaveProperty(
      'libc'
    );
  });

  it('does not mutate the input lockfile', () => {
    applyLibc(lock, lookup);
    expect(lock.packages?.['node_modules/musl-pkg']).not.toHaveProperty('libc');
  });

  it('changes nothing but libc', () => {
    const repair = applyLibc(lock, lookup);
    const before = JSON.parse(JSON.stringify(lock)) as LibcLockfile;
    const after = JSON.parse(JSON.stringify(repair.lockfile)) as LibcLockfile;
    for (const entry of Object.values(after.packages ?? {})) delete entry.libc;
    expect(after).toEqual(before);
  });

  it('reports an existing value that disagrees instead of overwriting it', () => {
    const wrong: LibcLockfile = {
      packages: {
        'node_modules/musl-pkg': {
          version: '1.0.0',
          resolved: `${REG}musl-pkg/-/x.tgz`,
          libc: ['glibc'],
        },
      },
    };
    const repair = applyLibc(wrong, lookup);
    expect(repair.mismatched).toEqual([
      { key: 'node_modules/musl-pkg', have: ['glibc'], want: ['musl'] },
    ]);
    // Untouched: a disagreement is for a human, not a guess.
    expect(repair.lockfile.packages?.['node_modules/musl-pkg'].libc).toEqual(['glibc']);
    expect(repair.added).toEqual([]);
  });

  it('reports a lockfile libc the registry no longer declares', () => {
    const stale: LibcLockfile = {
      packages: {
        'node_modules/plain': { version: '2.0.0', resolved: `${REG}plain/-/x.tgz`, libc: ['musl'] },
      },
    };
    expect(applyLibc(stale, lookup).mismatched).toEqual([
      { key: 'node_modules/plain', have: ['musl'], want: [] },
    ]);
  });

  it('counts an already-correct value without rewriting the entry', () => {
    const done: LibcLockfile = {
      packages: {
        'node_modules/musl-pkg': {
          version: '1.0.0',
          resolved: `${REG}musl-pkg/-/x.tgz`,
          libc: ['musl'],
        },
      },
    };
    const repair = applyLibc(done, lookup);
    expect(repair.alreadyCorrect).toEqual(['node_modules/musl-pkg']);
    expect(repair.added).toEqual([]);
    expect(repair.mismatched).toEqual([]);
  });

  it('looks up the alias target, not the install path', () => {
    const aliased: LibcLockfile = {
      packages: {
        'node_modules/renamed': {
          name: 'musl-pkg',
          version: '1.0.0',
          resolved: `${REG}musl-pkg/-/x.tgz`,
        },
      },
    };
    expect(applyLibc(aliased, lookup).added).toEqual([
      { key: 'node_modules/renamed', libc: ['musl'] },
    ]);
  });
});

describe('linuxWithoutLibc', () => {
  const lock: LibcLockfile = {
    packages: {
      '': { version: '0.9.0', os: ['linux'] },
      'node_modules/bare': { version: '1.0.0', os: ['linux'] },
      'node_modules/done': { version: '1.0.0', os: ['linux'], libc: ['musl'] },
      'node_modules/mac': { version: '1.0.0', os: ['darwin'] },
      'node_modules/anywhere': { version: '1.0.0' },
      'node_modules/empty-libc': { version: '1.0.0', os: ['linux'], libc: [] },
    },
  };

  it('lists linux packages declaring no libc', () => {
    expect(linuxWithoutLibc(lock)).toEqual([
      { key: 'node_modules/bare', label: 'bare@1.0.0' },
      { key: 'node_modules/empty-libc', label: 'empty-libc@1.0.0' },
    ]);
  });

  it('returns the key so callers can tell queried from never-asked', () => {
    // Without this the CLI labelled private-registry packages "upstream
    // declares none" without ever having made a request about them.
    expect(linuxWithoutLibc(lock).map((e) => e.key)).toEqual([
      'node_modules/bare',
      'node_modules/empty-libc',
    ]);
  });

  it('skips the root entry, which is not a package', () => {
    expect(linuxWithoutLibc(lock).map((e) => e.key)).not.toContain('');
  });
});

describe('isValidPackageName', () => {
  it.each([
    ['unscoped', 'lightningcss'],
    ['scoped', '@img/sharp-linux-x64'],
    ['dots and underscores past the first character', 'a.b_c-d~e'],
    ['legacy uppercase, still resolvable on the registry', 'JSONStream'],
    ['at the 214-character cap', 'a'.repeat(214)],
  ])('accepts %s', (_label, name) => {
    expect(isValidPackageName(name)).toBe(true);
  });

  it.each([
    ['a second slash', '@scope/a/b'],
    ['an unscoped slash', 'a/b'],
    ['parent traversal', '../../etc/passwd'],
    ['a bare dot segment', '.'],
    ['an absolute URL', 'https://evil.com/x'],
    ['a protocol-relative host', '//evil.com/x'],
    ['a query string', 'pkg?x=1'],
    ['a fragment', 'pkg#frag'],
    ['a percent escape', 'pkg%2Fevil'],
    ['CRLF', 'pkg\r\nHost: evil.com'],
    ['whitespace', 'pkg name'],
    ['a leading dot', '.hidden'],
    ['a leading underscore', '_private'],
    ['an empty string', ''],
    ['over the 214-character cap', 'a'.repeat(215)],
    ['a scope with no name', '@scope/'],
    ['a scope marker alone', '@'],
  ])('rejects %s', (_label, name) => {
    expect(isValidPackageName(name)).toBe(false);
  });

  it('accepts every name in this repo’s real lockfile', () => {
    // The validator gates a network call for every dependency, so a rule that
    // is merely plausible against invented fixtures is not good enough — one
    // false rejection aborts the whole repair. Asserted against the real file
    // with a real count, not a shape.
    const lock = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package-lock.json'), 'utf8')
    ) as LibcLockfile;

    const names = new Set(libcCandidates(lock).map((c) => c.name));
    expect(names.size).toBeGreaterThan(1000);
    expect([...names].filter((name) => !isValidPackageName(name))).toEqual([]);
  });
});
