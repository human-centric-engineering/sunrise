/**
 * Tests for `npm run test:changed`'s CLI.
 *
 * Driven against a scratch git repository with a **stub vitest** on disk, so
 * the argv this script builds is asserted as the argv vitest actually receives
 * rather than as the return value of a function that might not be wired to
 * anything. The stub records what it was called with and can be told to fail
 * or to die on a signal.
 *
 * The cases that matter are the ones where a wrong answer looks like a right
 * one: no base ref, `vitest list` failing, and vitest dying on a signal. Each
 * of those, handled badly, produces a short run and exit 0 — a gate that
 * passed because it could not look. They are asserted on the exit code, not on
 * the message.
 *
 * @see scripts/ci/run-scoped-tests.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { alwaysRunPaths } from '@/scripts/ci/scoped-tests';
import {
  changedPaths,
  countOverlap,
  gitErrorMessage,
  lines,
  main,
  reportUndeclared,
  selectChangedTests,
  vitestEntry,
} from '@/scripts/ci/run-scoped-tests';

/** Two entries from the real always-run list, materialised in the scratch repo. */
const ALWAYS_RUN_FIXTURES = [
  'tests/unit/lib/privacy/export-sources.test.ts',
  'tests/unit/reserved-fork-tiers.test.ts',
];

/** Where the stub vitest records the argv it was handed. */
const LIST_LOG = 'list-argv.json';
const RUN_LOG = 'run-argv.json';

const STUB = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const home = process.env.SCOPED_STUB_HOME;
if (argv[0] === 'list') {
  writeFileSync(join(home, '${LIST_LOG}'), JSON.stringify(argv));
  if (process.env.SCOPED_STUB_LIST_FAILS === '1') {
    console.error('stub: refusing to list');
    process.exit(2);
  }
  if (process.env.SCOPED_STUB_SELECT_NOTHING !== '1') {
    console.log('tests/unit/stub-a.test.ts');
    console.log('tests/unit/stub-b.test.ts');
  }
  if (process.env.SCOPED_STUB_EXTRA) console.log(process.env.SCOPED_STUB_EXTRA);
  console.log('');
  process.exit(0);
}
writeFileSync(join(home, '${RUN_LOG}'), JSON.stringify(argv));
if (process.env.SCOPED_STUB_SIGNAL === '1') process.kill(process.pid, 'SIGKILL');
process.exit(Number(process.env.SCOPED_STUB_RUN_EXIT ?? '0'));
`;

let repo: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'scoped-run-'));
  git(['init', '--initial-branch=main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'lib-a.ts'), 'export const a = 1;\n');
  // Mirrors the real repo: without it the stub vitest below is untracked and
  // lands in the changed-path list, which is what the first run of this test
  // actually reported.
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);

  mkdirSync(join(repo, 'node_modules/vitest'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/vitest/vitest.mjs'), STUB);

  // The runner validates every listed line by existence, so the fixture has to
  // put the files on disk. vitest never lists a file that is not there, and a
  // fixture that pretended otherwise was testing a world that cannot happen.
  mkdirSync(join(repo, 'tests/unit'), { recursive: true });
  writeFileSync(join(repo, 'tests/unit/stub-a.test.ts'), '');
  writeFileSync(join(repo, 'tests/unit/stub-b.test.ts'), '');

  // Two real ALWAYS_RUN_TESTS paths, so `main`'s always-run set is non-empty
  // in the tests below. Without these the scratch repo contained none of them,
  // every test ran with `alwaysRun` empty, and a regression that dropped the
  // union from the plan — the whole point of this runner — would have passed
  // the entire file.
  for (const path of ALWAYS_RUN_FIXTURES) {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), '');
  }

  // One tracked edit and one untracked file — the two ways a pre-commit gate
  // sees work, and `git diff` only reports the first.
  writeFileSync(join(repo, 'lib-a.ts'), 'export const a = 2;\n');
  writeFileSync(join(repo, 'lib-b.ts'), 'export const b = 1;\n');

  process.env.SCOPED_STUB_HOME = repo;
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  delete process.env.SCOPED_STUB_HOME;
  delete process.env.SCOPED_STUB_LIST_FAILS;
  delete process.env.SCOPED_STUB_RUN_EXIT;
  delete process.env.SCOPED_STUB_SIGNAL;
  delete process.env.SCOPED_STUB_EXTRA;
  delete process.env.SCOPED_STUB_SELECT_NOTHING;
});

beforeEach(() => {
  delete process.env.SCOPED_STUB_LIST_FAILS;
  delete process.env.SCOPED_STUB_RUN_EXIT;
  delete process.env.SCOPED_STUB_SIGNAL;
  delete process.env.SCOPED_STUB_EXTRA;
  delete process.env.SCOPED_STUB_SELECT_NOTHING;
  rmSync(join(repo, LIST_LOG), { force: true });
  rmSync(join(repo, RUN_LOG), { force: true });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function head(): string {
  return git(['rev-parse', 'HEAD'], repo).trim();
}

function runArgv(): string[] {
  return JSON.parse(readFileSync(join(repo, RUN_LOG), 'utf8')) as string[];
}

describe('lines', () => {
  it('drops blanks and trims, and answers null with an empty list', () => {
    expect(lines('a\n\n  b  \n')).toEqual(['a', 'b']);
    expect(lines(null)).toEqual([]);
  });
});

describe('gitErrorMessage', () => {
  it('prefers stderr, where git puts the actual diagnosis', () => {
    const error = Object.assign(new Error('Command failed: git diff'), {
      stderr: "fatal: bad revision 'nope'\nmore noise\n",
    });
    expect(gitErrorMessage(error)).toBe("fatal: bad revision 'nope'");
  });

  it('falls back to the Error message when stderr is empty', () => {
    expect(gitErrorMessage(Object.assign(new Error('spawn ENOENT'), { stderr: '   ' }))).toBe(
      'spawn ENOENT'
    );
  });

  it('falls back to the Error message when there is no stderr at all', () => {
    expect(gitErrorMessage(new Error('spawn ENOENT'))).toBe('spawn ENOENT');
  });

  it('stringifies something that is not an Error rather than throwing', () => {
    expect(gitErrorMessage('plain string failure')).toBe('plain string failure');
  });
});

describe('countOverlap', () => {
  it('counts only members present in both', () => {
    expect(countOverlap(['a', 'b'], ['b', 'c'])).toBe(1);
    expect(countOverlap([], ['a'])).toBe(0);
  });
});

describe('vitestEntry', () => {
  it('finds the entry point when dependencies are installed', () => {
    expect(vitestEntry(repo)).toBe(resolve(repo, 'node_modules/vitest/vitest.mjs'));
  });

  it('returns null rather than a path that does not exist', () => {
    const bare = mkdtempSync(join(tmpdir(), 'scoped-bare-'));
    expect(vitestEntry(bare)).toBeNull();
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('changedPaths', () => {
  it('reports tracked edits and untracked files together', () => {
    const { paths, failed } = changedPaths(head(), repo);
    expect(failed).toBe(false);
    // lib-b.ts is untracked; `git diff` alone would miss it, and a brand-new
    // source file with no test is exactly what a pre-PR gate is looking for.
    // node_modules is absent because `--exclude-standard` honours .gitignore —
    // without that the vendored tree would be gated for coverage.
    expect(paths).toEqual([
      'lib-a.ts',
      'lib-b.ts',
      'tests/unit/lib/privacy/export-sources.test.ts',
      'tests/unit/reserved-fork-tiers.test.ts',
      'tests/unit/stub-a.test.ts',
      'tests/unit/stub-b.test.ts',
    ]);
  });

  it('reports failure rather than an empty diff when git cannot answer', () => {
    const { paths, failed } = changedPaths('no-such-ref', repo);
    expect(failed).toBe(true);
    expect(paths).toEqual([]);
  });
});

describe('selectChangedTests', () => {
  it('keeps only test paths from the listing output', () => {
    const result = selectChangedTests(vitestEntry(repo) as string, head(), repo);
    expect(result.failed).toBe(false);
    expect(result.files).toEqual(['tests/unit/stub-a.test.ts', 'tests/unit/stub-b.test.ts']);
    expect(result.unrecognised).toEqual([]);
  });

  it('collects a listed line that is not a file rather than dropping it', () => {
    // A `projects` config prefixes each line with `[name] `, and a newline in a
    // filename splits one line into two. Both still looked like test paths to
    // the old extension filter, or vanished from it — either way the run got
    // shorter with nothing said.
    process.env.SCOPED_STUB_EXTRA = '[unit] tests/unit/stub-a.test.ts';
    const result = selectChangedTests(vitestEntry(repo) as string, head(), repo);
    expect(result.files).toEqual(['tests/unit/stub-a.test.ts', 'tests/unit/stub-b.test.ts']);
    expect(result.unrecognised).toEqual(['[unit] tests/unit/stub-a.test.ts']);
  });

  it('keeps a .spec.ts file, which the old extension filter silently dropped', () => {
    // vitest.config.ts's include glob covers `.spec.*` and `.test.js` too; a
    // filter hardcoded to `.test.ts`/`.test.tsx` dropped a fork's spec files
    // from the selection without a word.
    writeFileSync(join(repo, 'tests/unit/stub-c.spec.ts'), '');
    process.env.SCOPED_STUB_EXTRA = 'tests/unit/stub-c.spec.ts';
    const result = selectChangedTests(vitestEntry(repo) as string, head(), repo);
    expect(result.files).toContain('tests/unit/stub-c.spec.ts');
    expect(result.unrecognised).toEqual([]);
    rmSync(join(repo, 'tests/unit/stub-c.spec.ts'), { force: true });
  });

  it('reports failure when the listing exits non-zero', () => {
    process.env.SCOPED_STUB_LIST_FAILS = '1';
    const result = selectChangedTests(vitestEntry(repo) as string, head(), repo);
    expect(result.failed).toBe(true);
    expect(result.stderr).toContain('refusing to list');
  });

  it('reports failure with an empty message when the child never started', () => {
    // spawnSync leaves stdout/stderr null when it cannot spawn at all, so the
    // `?? ''` here is the difference between an empty message and a crash
    // while trying to report one.
    const result = selectChangedTests(join(repo, 'no-such-entry.mjs'), head(), repo);
    expect(result.failed).toBe(true);
    expect(typeof result.stderr).toBe('string');
  });
});

describe('reportUndeclared', () => {
  it('says so when it cannot find any tests, rather than printing a clean result', () => {
    // An empty scan that prints nothing is #641's exact shape: a check that
    // could not look, read as a check that found nothing. Needs a tree with no
    // `tests/` at all, which the main fixture no longer is.
    const bare = mkdtempSync(join(tmpdir(), 'scoped-notests-'));
    const warn = vi.spyOn(console, 'warn');
    reportUndeclared(bare);
    expect(warn.mock.calls.flat().join('\n')).toContain('found no test files');
    rmSync(bare, { recursive: true, force: true });
  });

  it('lists undeclared repo-rooted tests and caps the listing', () => {
    const tree = mkdtempSync(join(tmpdir(), 'scoped-tree-'));
    mkdirSync(join(tree, 'tests/unit'), { recursive: true });
    for (let i = 0; i < 12; i += 1) {
      writeFileSync(join(tree, `tests/unit/probe-${i}.test.ts`), 'readFileSync(process.cwd());\n');
    }
    const log = vi.spyOn(console, 'log');
    reportUndeclared(tree);
    const printed = log.mock.calls.flat().join('\n');
    expect(printed).toContain('12 test(s) read from the repo root');
    expect(printed).toContain('(+2 more)');
    rmSync(tree, { recursive: true, force: true });
  });
});

describe('main', () => {
  it('passes its own self-test', () => {
    expect(main(['--self-test'], repo)).toBe(0);
  });

  it('refuses to run at all when the sentinel reports the selector is broken', () => {
    // The sentinel gates everything, including `--self-test` itself. A runner
    // that reported a plan built by a selector it had just found broken would
    // be worse than one that did not check.
    const broken = (): string => 'the detector returned nothing';
    expect(main(['--self-test'], repo, broken)).toBe(1);
    expect(main(['--base', head(), '--no-fetch'], repo, broken)).toBe(1);
    expect(existsSync(join(repo, RUN_LOG))).toBe(false);
  });

  it('warns and carries on when origin/main cannot be fetched', () => {
    // No remote in the scratch repo. Offline should still be able to run
    // tests — it just has to be told what it is comparing against, because a
    // stale base is a short file list and a short list is a quiet pass.
    const warn = vi.spyOn(console, 'warn');
    main([], repo);
    expect(warn.mock.calls.flat().join('\n')).toContain('Could not fetch origin/main');
  });

  it('refuses an empty --base', () => {
    expect(main(['--base', ''], repo)).toBe(1);
  });

  it('refuses a --base that is an option rather than a revision', () => {
    expect(main(['--base', '--coverage'], repo)).toBe(1);
  });

  it('refuses to run when vitest is not installed', () => {
    const bare = mkdtempSync(join(tmpdir(), 'scoped-bare-'));
    expect(main(['--base', 'HEAD', '--no-fetch'], bare)).toBe(1);
    rmSync(bare, { recursive: true, force: true });
  });

  it('refuses to run when the base cannot be resolved', () => {
    // No `origin/main` in the scratch repo, so `merge-base` fails. The answer
    // has to be exit 1: running the always-run set against an unknown base and
    // reporting 0 is a gate that passed because it could not look.
    expect(main(['--no-fetch'], repo)).toBe(1);
  });

  it('refuses to run when the changed-file diff fails', () => {
    expect(main(['--base', 'no-such-ref', '--no-fetch'], repo)).toBe(1);
  });

  it('refuses to run a partial selection when vitest list fails', () => {
    process.env.SCOPED_STUB_LIST_FAILS = '1';
    expect(main(['--base', head(), '--no-fetch'], repo)).toBe(1);
    expect(existsSync(join(repo, RUN_LOG))).toBe(false);
  });

  it('refuses to run when a selected line would arrive as a vitest option', () => {
    // The shape a newline-named file produces: `vitest list` splits it across
    // two lines, so the second fragment arrives as its own token. vitest reads
    // options wherever they appear, so running anyway would let it replace the
    // config for the run. It is caught by the existence check — no such file —
    // which is the earlier and more fundamental of the two guards.
    process.env.SCOPED_STUB_EXTRA = '--config=payload.test.ts';
    const err = vi.spyOn(console, 'error');
    expect(main(['--base', head(), '--no-fetch'], repo)).toBe(1);
    expect(existsSync(join(repo, RUN_LOG))).toBe(false);
    expect(err.mock.calls.flat().join('\n')).toContain('not files in this tree');
  });

  it('refuses a coverage target that would arrive as an option', () => {
    // The argv guard's own path: a real file whose name starts with a dash
    // reaches `--coverage.include` and would be re-read as a flag.
    writeFileSync(join(repo, '-dash.ts'), 'export const d = 1;\n');
    const err = vi.spyOn(console, 'error');
    expect(main(['--base', head(), '--no-fetch', '--coverage'], repo)).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('cannot be passed to vitest safely');
    rmSync(join(repo, '-dash.ts'), { force: true });
  });

  it('hands the always-run tests to vitest, not just the selected ones', () => {
    // The feature's whole point, asserted where it actually happens. vitest
    // INTERSECTS positional filters with `--changed`, so the union has to be
    // built here and passed as files — a plan that dropped `alwaysRun` would
    // still produce a green run over the selected files alone.
    expect(main(['--base', head(), '--no-fetch'], repo)).toBe(0);
    const argv = runArgv();
    for (const path of ALWAYS_RUN_FIXTURES) expect(argv).toContain(path);
    // And they are genuinely extra — the module graph did not select them.
    const selected = selectChangedTests(vitestEntry(repo) as string, head(), repo).files;
    for (const path of ALWAYS_RUN_FIXTURES) expect(selected).not.toContain(path);
  });

  it('forwards an unknown flag to vitest without needing a -- separator', () => {
    // npm eats the first `--`, so `npm run test:changed -- --reporter=dot`
    // delivers argv with no separator left in it. The old parser forwarded
    // nothing and ignored the flag silently, which made both documented
    // examples wrong.
    expect(main(['--base', head(), '--no-fetch', '--reporter=dot'], repo)).toBe(0);
    expect(runArgv()).toContain('--reporter=dot');
  });

  it('does not run vitest at all when the union is empty', () => {
    // `vitest run` with no file filters runs the WHOLE suite, so an empty plan
    // must not reach it. Reproduced by pointing the runner at a tree with no
    // always-run tests and a stub that selects nothing.
    const empty = mkdtempSync(join(tmpdir(), 'scoped-empty-'));
    git(['init', '--initial-branch=main'], empty);
    git(['config', 'user.email', 'test@example.com'], empty);
    git(['config', 'user.name', 'Test'], empty);
    writeFileSync(join(empty, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(empty, 'README.md'), 'one\n');
    git(['add', '.'], empty);
    git(['commit', '-m', 'base'], empty);
    mkdirSync(join(empty, 'node_modules/vitest'), { recursive: true });
    writeFileSync(join(empty, 'node_modules/vitest/vitest.mjs'), STUB);

    const previousHome = process.env.SCOPED_STUB_HOME;
    process.env.SCOPED_STUB_HOME = empty;
    process.env.SCOPED_STUB_SELECT_NOTHING = '1';
    const log = vi.spyOn(console, 'log');
    const sha = git(['rev-parse', 'HEAD'], empty).trim();

    expect(main(['--base', sha, '--no-fetch'], empty)).toBe(0);
    expect(existsSync(join(empty, RUN_LOG))).toBe(false);
    expect(log.mock.calls.flat().join('\n')).toContain('nothing to run');

    process.env.SCOPED_STUB_HOME = previousHome;
    delete process.env.SCOPED_STUB_SELECT_NOTHING;
    rmSync(empty, { recursive: true, force: true });
  });

  it('runs the selected tests and returns vitest’s exit code', () => {
    expect(main(['--base', head(), '--no-fetch'], repo)).toBe(0);
    const argv = runArgv();
    expect(argv[0]).toBe('run');
    expect(argv).toContain('tests/unit/stub-a.test.ts');
    expect(argv).toContain('tests/unit/stub-b.test.ts');
  });

  it('propagates a failing vitest rather than reporting its own success', () => {
    process.env.SCOPED_STUB_RUN_EXIT = '7';
    expect(main(['--base', head(), '--no-fetch'], repo)).toBe(7);
  });

  it('reports a signal death as a failure, not as a pass', () => {
    // `spawnSync` leaves `status` null when the child is killed. Returning 0
    // there turns an OOM or a Ctrl-C into a green gate — the same hole
    // `ci-status` had when it tested for `failure` and let `cancelled` through.
    process.env.SCOPED_STUB_SIGNAL = '1';
    expect(main(['--base', head(), '--no-fetch'], repo)).toBe(1);
  });

  it('gates coverage on the changed sources, per file', () => {
    expect(main(['--base', head(), '--no-fetch', '--coverage'], repo)).toBe(0);
    const argv = runArgv();
    expect(argv).toContain('--coverage');
    expect(argv).toContain('--coverage.include=lib-a.ts');
    expect(argv).toContain('--coverage.include=lib-b.ts');
    expect(argv).toContain('--coverage.thresholds.perFile=true');
    expect(argv).toContain('--coverage.thresholds.lines=80');
  });

  it('says so when coverage was asked for but no TypeScript changed', () => {
    // A docs-only branch is a legitimate clean run, not a coverage failure —
    // but it has to say which of the two it is, or "0 files gated" reads as
    // "everything passed".
    const docs = mkdtempSync(join(tmpdir(), 'scoped-docs-'));
    git(['init', '--initial-branch=main'], docs);
    git(['config', 'user.email', 'test@example.com'], docs);
    git(['config', 'user.name', 'Test'], docs);
    writeFileSync(join(docs, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(docs, 'README.md'), 'one\n');
    git(['add', '.'], docs);
    git(['commit', '-m', 'base'], docs);
    mkdirSync(join(docs, 'node_modules/vitest'), { recursive: true });
    writeFileSync(join(docs, 'node_modules/vitest/vitest.mjs'), STUB);
    // The stub lists these, and the runner validates every listed line by
    // existence — so they have to be on disk here too.
    mkdirSync(join(docs, 'tests/unit'), { recursive: true });
    writeFileSync(join(docs, 'tests/unit/stub-a.test.ts'), '');
    writeFileSync(join(docs, 'tests/unit/stub-b.test.ts'), '');
    writeFileSync(join(docs, 'README.md'), 'two\n');

    const log = vi.spyOn(console, 'log');
    const sha = git(['rev-parse', 'HEAD'], docs).trim();
    expect(main(['--base', sha, '--no-fetch', '--coverage', '--dry-run'], docs)).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('no TypeScript sources changed');
    rmSync(docs, { recursive: true, force: true });
  });

  it('asks for no coverage unless told to', () => {
    expect(main(['--base', head(), '--no-fetch'], repo)).toBe(0);
    expect(runArgv().join(' ')).not.toContain('coverage');
  });

  it('forwards everything after -- to vitest verbatim', () => {
    expect(main(['--base', head(), '--no-fetch', '--', '--reporter=dot'], repo)).toBe(0);
    expect(runArgv()).toContain('--reporter=dot');
  });

  it('does not treat a forwarded --coverage as a request to gate coverage', () => {
    // `--` is the boundary: flags past it are vitest's business. Reading the
    // whole argv for `--coverage` would make this build an include list from
    // the changed files as a side effect of the user asking vitest for a plain
    // coverage report.
    expect(main(['--base', head(), '--no-fetch', '--', '--coverage'], repo)).toBe(0);
    expect(runArgv().join(' ')).not.toContain('--coverage.include');
  });

  it('prints the plan and runs nothing under --dry-run', () => {
    expect(main(['--base', head(), '--no-fetch', '--dry-run'], repo)).toBe(0);
    expect(existsSync(join(repo, RUN_LOG))).toBe(false);
  });

  it('warns about an always-run entry missing from the tree instead of skipping it', () => {
    // The scratch repo materialises two entries and not the rest, which is the
    // shape a fork hits after deleting or renaming one of these tests.
    const warn = vi.spyOn(console, 'warn');
    main(['--base', head(), '--no-fetch', '--dry-run'], repo);
    const warned = warn.mock.calls.flat().join('\n');
    expect(warned).toContain('always-run entry not found');
    // The fixture materialises two entries, so name one it does NOT create —
    // otherwise this asserts on a file that is present and proves nothing.
    const absent = alwaysRunPaths().filter((path) => !ALWAYS_RUN_FIXTURES.includes(path));
    expect(absent.length).toBeGreaterThan(0);
    expect(warned).toContain(absent[0]);
  });
});
