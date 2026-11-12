/**
 * Tests: scripts/ci/validate-changed.mjs
 *
 * A scoped check fails in silence: a file set that is too small does not
 * error, it passes faster having checked less. So most of what is asserted here
 * is about the file set — that every listing is required, that a failed one
 * fails the run, and that a change which moves results in unchanged files
 * widens the tool to the whole tree.
 *
 * Collaborators (`git`, `exists`, the ignore lookup and both tools) are
 * injected, so nothing here spawns ESLint or Prettier. The real run is proven by
 * running `npm run validate:changed` itself.
 *
 * @see scripts/ci/validate-changed.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

import {
  asPathArgs,
  changedFiles,
  ESLINT_ARGS,
  main,
  plan,
  PRETTIER_ARGS,
  resolveBase,
  splitNul,
  widenedBy,
  LINT_WIDENERS,
  FORMAT_WIDENERS,
} from '@/scripts/ci/validate-changed.mjs';

const BASE = 'abc1234def5678';

/** A git fake answering the three listings and the merge base. */
function fakeGit(
  opts: {
    branch?: string[] | null;
    uncommitted?: string[] | null;
    untracked?: string[] | null;
    mergeBase?: string | null;
  } = {}
) {
  const { branch = [], uncommitted = [], untracked = [], mergeBase = `${BASE}\n` } = opts;
  const nul = (list: string[] | null) =>
    list === null ? null : list.map((f) => `${f}\0`).join('');
  return vi.fn((args: readonly string[]): string | null => {
    if (args[0] === 'merge-base') return mergeBase;
    if (args.includes('ls-files')) return nul(untracked);
    if (args.includes(`${BASE}...HEAD`) || args.some((a) => a.endsWith('...HEAD')))
      return nul(branch);
    if (args.includes('HEAD')) return nul(uncommitted);
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  });
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    git: fakeGit(),
    exists: () => true,
    isLintIgnored: async () => false,
    lint: vi.fn(async () => 0),
    format: vi.fn(async () => 0),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe('splitNul', () => {
  it('splits on NUL only and keeps whitespace in a path', () => {
    expect(splitNul('a.ts\0 b c.ts \0new\nline.ts\0')).toEqual([
      'a.ts',
      ' b c.ts ',
      'new\nline.ts',
    ]);
  });
});

describe('resolveBase', () => {
  it('uses an explicit --base without asking git', () => {
    const git = vi.fn();
    expect(resolveBase(['--base', 'v0.18.0'], git)).toEqual({ base: 'v0.18.0' });
    expect(git).not.toHaveBeenCalled();
  });

  it('refuses --base with no revision, or with a flag in its place', () => {
    expect(resolveBase(['--base'], vi.fn())).toHaveProperty('error');
    expect(resolveBase(['--base', '--other'], vi.fn())).toHaveProperty('error');
  });

  it('falls back to the merge base with origin/main, trimmed', () => {
    const git = fakeGit();
    expect(resolveBase([], git)).toEqual({ base: BASE });
    expect(git).toHaveBeenCalledWith(['merge-base', 'origin/main', 'HEAD']);
  });

  it('reports an error when there is no merge base', () => {
    expect(resolveBase([], fakeGit({ mergeBase: null }))).toHaveProperty('error');
  });
});

describe('changedFiles', () => {
  it('unions the branch diff, uncommitted and untracked files, deduped and sorted', () => {
    const git = fakeGit({
      branch: ['b.ts', 'a.ts'],
      uncommitted: ['a.ts', 'c.md'],
      untracked: ['d.json'],
    });
    expect(changedFiles(BASE, { git, exists: () => true })).toEqual([
      'a.ts',
      'b.ts',
      'c.md',
      'd.json',
    ]);
    // The branch half is diffed against the base, three-dot.
    expect(git).toHaveBeenCalledWith(
      expect.arrayContaining(['diff', '--name-only', '-z', `${BASE}...HEAD`])
    );
  });

  it('drops paths that no longer exist on disk', () => {
    const git = fakeGit({ branch: ['kept.ts', 'deleted.ts'] });
    expect(changedFiles(BASE, { git, exists: (f) => f === 'kept.ts' })).toEqual(['kept.ts']);
  });

  it.each([
    ['the branch diff', { branch: null }],
    ['the uncommitted listing', { uncommitted: null }],
    ['the untracked listing', { untracked: null }],
  ])('returns null when %s fails, instead of a smaller set', (_name, failing) => {
    const git = fakeGit({
      branch: ['a.ts'],
      uncommitted: ['b.ts'],
      untracked: ['c.ts'],
      ...failing,
    });
    expect(changedFiles(BASE, { git, exists: () => true })).toBeNull();
  });
});

describe('widenedBy', () => {
  it.each([
    'eslint.config.mjs',
    'lib/app/eslint.config.mjs',
    'lib/framework/eslint.config.mjs',
    'tsconfig.json',
    'tsconfig.build.json',
    'package-lock.json',
  ])('widens the lint for %s', (file) => {
    expect(widenedBy(['lib/a.ts', file], LINT_WIDENERS)).toBe(file);
  });

  it.each([
    '.prettierrc',
    '.prettierrc.json',
    'prettier.config.mjs',
    '.prettierignore',
    'package-lock.json',
  ])('widens the format check for %s', (file) => {
    expect(widenedBy([file], FORMAT_WIDENERS)).toBe(file);
  });

  it('does not widen for package.json alone, or a nested tsconfig', () => {
    // An edit that changes no installed version changes no result; one that
    // does also changes the lockfile.
    expect(widenedBy(['package.json', 'lib/x/tsconfig.json'], LINT_WIDENERS)).toBeUndefined();
    expect(widenedBy(['package.json'], FORMAT_WIDENERS)).toBeUndefined();
  });
});

describe('plan', () => {
  it('lints only lintable, non-ignored files and formats every changed file', async () => {
    const files = ['Dockerfile', 'README.md', 'lib/a.ts', 'scripts/b.mjs', 'vendor/c.js'];
    const isLintIgnored = vi.fn(async (f: string) => f.startsWith('vendor/'));
    const result = await plan(files, isLintIgnored);
    expect(result.lint).toEqual({ files: ['lib/a.ts', 'scripts/b.mjs'] });
    // Prettier gets everything; `--ignore-unknown` skips what it cannot parse.
    expect(result.format).toEqual({ files });
    // Only lintable extensions are asked about.
    expect(isLintIgnored).not.toHaveBeenCalledWith('README.md');
  });

  it('widens each tool independently', async () => {
    const result = await plan(['eslint.config.mjs', 'lib/a.ts'], async () => false);
    expect(result.lint).toEqual({ whole: 'eslint.config.mjs' });
    expect(result.format).toEqual({ files: ['eslint.config.mjs', 'lib/a.ts'] });
  });
});

describe('asPathArgs', () => {
  it('prefixes ./ so a file named like a flag stays a path', () => {
    expect(asPathArgs(['--write', 'a.ts'])).toEqual(['./--write', './a.ts']);
  });
});

describe('main', () => {
  it('fails closed when no base can be resolved, running neither tool', async () => {
    const d = deps({ git: fakeGit({ mergeBase: null }) });
    expect(await main([], d)).toBe(1);
    expect(d.lint).not.toHaveBeenCalled();
    expect(d.format).not.toHaveBeenCalled();
    expect(d.error).toHaveBeenCalledWith(expect.stringContaining('could not run'));
  });

  it('fails closed when a listing fails, running neither tool', async () => {
    const d = deps({ git: fakeGit({ branch: null, uncommitted: ['a.ts'] }) });
    expect(await main([], d)).toBe(1);
    expect(d.lint).not.toHaveBeenCalled();
    expect(d.format).not.toHaveBeenCalled();
  });

  it('passes with nothing in scope, running neither tool', async () => {
    const d = deps();
    expect(await main([], d)).toBe(0);
    expect(d.lint).not.toHaveBeenCalled();
    expect(d.format).not.toHaveBeenCalled();
  });

  it('hands each tool the scoped files', async () => {
    const d = deps({ git: fakeGit({ branch: ['lib/a.ts', 'docs/b.md'] }) });
    expect(await main([], d)).toBe(0);
    expect(d.lint).toHaveBeenCalledWith(['lib/a.ts']);
    expect(d.format).toHaveBeenCalledWith(['./docs/b.md', './lib/a.ts']);
  });

  it('runs a widened tool over the whole tree and says why', async () => {
    const d = deps({ git: fakeGit({ branch: ['package-lock.json', 'lib/a.ts'] }) });
    await main([], d);
    expect(d.lint).toHaveBeenCalledWith(['.']);
    expect(d.format).toHaveBeenCalledWith(['.']);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('package-lock.json changed'));
  });

  it('runs Prettier after a lint failure and returns the worst exit code', async () => {
    const d = deps({
      git: fakeGit({ branch: ['lib/a.ts'] }),
      lint: vi.fn(async () => 134),
      format: vi.fn(async () => 1),
    });
    expect(await main([], d)).toBe(134);
    expect(d.format).toHaveBeenCalled();
  });
});

describe('agreement with package.json', () => {
  const scripts = (
    JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;

  it('passes the same ESLint cache flags as `lint`, so the two share a cache', () => {
    expect(scripts.lint).toContain(ESLINT_ARGS.join(' '));
  });

  it('passes the same Prettier cache flags as `format:check`', () => {
    const cacheFlags = PRETTIER_ARGS.filter((a) => a !== '--check' && a !== '--ignore-unknown');
    expect(scripts['format:check']).toContain(cacheFlags.join(' '));
  });

  it('is `validate` with only the lint and Prettier steps swapped for this script', () => {
    const expected = scripts.validate.replace(
      'npm run lint && npm run format:check',
      'node scripts/ci/validate-changed.mjs'
    );
    expect(scripts['validate:changed']).toBe(expected);
  });
});
