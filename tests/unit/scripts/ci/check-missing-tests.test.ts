/**
 * Tests for the step 4f CLI.
 *
 * The rules live in `missing-tests.test.ts`; this covers the wiring, and one
 * property that is the entire reason #641 exists:
 *
 * > **No path that fails to look prints a clean result.**
 *
 * A hand-rolled version of this check printed nothing when it could not run,
 * and nothing is indistinguishable from a pass. So every way this CLI can fail
 * to see — no base, git erroring, an empty test tree, a broken classifier —
 * is asserted to exit non-zero *and* to keep the word CLEAN off stdout.
 *
 * @see scripts/ci/check-missing-tests.ts
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { Verdict } from '@/scripts/ci/missing-tests';

const mockExecFileSync = vi.fn();
vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  default: { execFileSync: mockExecFileSync },
}));

const mockSelfTestFailure = vi.fn<() => string | null>(() => null);
vi.mock('@/scripts/ci/missing-tests', async () => {
  const actual = await vi.importActual<typeof import('@/scripts/ci/missing-tests')>(
    '@/scripts/ci/missing-tests'
  );
  return { ...actual, selfTestFailure: () => mockSelfTestFailure() };
});

const {
  main,
  parseBaseRef,
  parseNameStatus,
  listTestFiles,
  makeReader,
  makeReferenceFinder,
  uncommittedSources,
  formatReport,
  describe: describeVerdict,
} = await import('@/scripts/ci/check-missing-tests');

/** Answers `git` calls by matching the subcommand, so order does not matter. */
function gitReturns(responses: Record<string, string | Error>): void {
  mockExecFileSync.mockImplementation((_bin: string, args: string[]) => {
    for (const [key, value] of Object.entries(responses)) {
      if (args.join(' ').includes(key)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return '';
  });
}

describe('scripts/ci/check-missing-tests', () => {
  let dir: string;
  let logs: string[];
  let errors: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunrise-4f-test-'));
    logs = [];
    errors = [];
    mockSelfTestFailure.mockReturnValue(null);
    mockExecFileSync.mockReset();
    vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
      logs.push(parts.join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
      errors.push(parts.join(' '));
    });
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** A verdict for `lib/a.ts`, modified, unless the test says otherwise. */
  function verdict(outcome: Verdict['outcome'], over: Partial<Verdict> = {}): Verdict {
    return { path: 'lib/a.ts', status: 'M', outcome, ...over };
  }

  /** Writes a file under the temp repo, creating parents. */
  function write(relative: string, contents = '// x\n'): void {
    const full = join(dir, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }

  describe('parseBaseRef', () => {
    it.each([
      [['--base', 'main'], { present: true, ref: 'main' }],
      [['--base=main'], { present: true, ref: 'main' }],
      [['--base'], { present: true, ref: '' }],
      [[], { present: false, ref: '' }],
    ])('parses %j', (argv, expected) => {
      expect(parseBaseRef(argv)).toEqual(expected);
    });
  });

  describe('parseNameStatus', () => {
    it('keeps added and modified TypeScript files', () => {
      expect(parseNameStatus('A\tlib/a.ts\nM\tapp/b.tsx\n').files).toEqual([
        { path: 'lib/a.ts', status: 'A' },
        { path: 'app/b.tsx', status: 'M' },
      ]);
    });

    it('takes the destination of a rename, which is the file needing a test', () => {
      expect(parseNameStatus('R100\tlib/old.ts\tlib/new.ts\n').files).toEqual([
        { path: 'lib/new.ts', status: 'R' },
      ]);
    });

    it('keeps the destination of a copy, which is a new file needing a test', () => {
      // `diff.renames = copies` in a user's gitconfig produces these. The
      // letter test used to accept only A/M/R, so the new file fell out with no
      // word — the silent drop this check is against.
      expect(parseNameStatus('C100\tlib/src.ts\tlib/dst.ts\n').files).toEqual([
        { path: 'lib/dst.ts', status: 'A' },
      ]);
    });

    it('drops deletions', () => {
      // A deleted file cannot be missing a test, and reporting one sends the
      // reader to write a test for a path that no longer exists.
      expect(parseNameStatus('D\tlib/gone.ts\n').files).toEqual([]);
    });

    it.each(['M\tREADME.md', 'M\tprisma/schema/app.prisma', 'M\tpackage.json'])(
      'drops the non-TypeScript path in %j',
      (line) => {
        expect(parseNameStatus(`${line}\n`).files).toEqual([]);
      }
    );

    it('ignores blank lines rather than emitting an empty path', () => {
      expect(parseNameStatus('\n\nA\tlib/a.ts\n\n').files).toHaveLength(1);
    });

    it('collects a still-quoted path instead of dropping it', () => {
      // `core.quotePath` C-quotes a filename containing a tab, newline or
      // quote even with the flag the caller passes. Such a path ends in `"`,
      // so the extension test would drop it and the report would still say
      // CLEAN — a changed file vanishing from the scan without a word.
      const { files, unreadable } = parseNameStatus('A\t"caf\\303\\251.ts"\nA\tlib/a.ts\n');
      expect(files).toEqual([{ path: 'lib/a.ts', status: 'A' }]);
      expect(unreadable).toEqual(['"caf\\303\\251.ts"']);
    });

    it('ignores a quoted path that is not TypeScript', () => {
      // Quoting now only happens for a quote, backslash or control character in
      // the name, and those turn up in docs and assets. Aborting the scan for a
      // file 4f never looks at would be a self-inflicted COULD NOT RUN.
      const { files, unreadable } = parseNameStatus('A\t"notes \\"draft\\".md"\nA\tlib/a.ts\n');
      expect(unreadable).toEqual([]);
      expect(files).toEqual([{ path: 'lib/a.ts', status: 'A' }]);
    });

    it('survives a truncated rename line rather than throwing on it', () => {
      // `R100\told.ts` with no destination: reading `fields[2]` gives
      // undefined, and the extension test would throw on it — taking the whole
      // check down mid-scan.
      expect(() => parseNameStatus('R100\tlib/old.ts\nA\tlib/a.ts\n')).not.toThrow();
      expect(parseNameStatus('R100\tlib/old.ts\nA\tlib/a.ts\n').files).toEqual([
        { path: 'lib/a.ts', status: 'A' },
      ]);
    });
  });

  describe('listTestFiles', () => {
    it('finds both suffixes at any depth and ignores everything else', () => {
      write('tests/unit/lib/a.test.ts');
      write('tests/unit/components/b.test.tsx');
      write('tests/helpers/factory.ts');
      write('tests/README.md');
      expect(listTestFiles(dir)).toEqual([
        'tests/unit/components/b.test.tsx',
        'tests/unit/lib/a.test.ts',
      ]);
    });

    it('returns empty — not a throw — when there is no tests directory', () => {
      // `main` turns this into a loud failure; the lister itself must not
      // explode, or the loud failure never gets a chance to print.
      expect(listTestFiles(dir)).toEqual([]);
    });
  });

  describe('makeReferenceFinder', () => {
    const sources: Record<string, string> = {
      'tests/unit/a.test.ts': `import { escapeHtml } from '@/lib/security';`,
      'tests/unit/b.test.ts': `import { sanitizeUrl } from '@/lib/security/sanitize';`,
    };
    const read = (path: string): string | null => sources[path] ?? null;
    const files = Object.keys(sources);

    it('matches the exact specifier', () => {
      expect(makeReferenceFinder(files, read)(['@/lib/security'])).toEqual([
        'tests/unit/a.test.ts',
      ]);
    });

    it('does not let a barrel claim every module beneath it', () => {
      // Without the lookahead, `@/lib/security` matches
      // `@/lib/security/sanitize` and the barrel absorbs its whole subtree.
      expect(makeReferenceFinder(files, read)(['@/lib/security'])).not.toContain(
        'tests/unit/b.test.ts'
      );
    });

    it('reads nothing until it is asked a question', () => {
      const reader = vi.fn(read);
      const find = makeReferenceFinder(files, reader);
      expect(reader).not.toHaveBeenCalled();
      find(['@/lib/security']);
      expect(reader).toHaveBeenCalled();
    });
  });

  describe('formatReport', () => {
    it('says CLEAN only when nothing was found', () => {
      const lines = formatReport([
        verdict({ kind: 'covered', testPath: 't.test.ts', via: 'mirror' }),
      ]);
      expect(lines.at(-1)).toContain('CLEAN');
    });

    it('never says CLEAN when something was referenced-only', () => {
      // The tier that is easiest to round down to a pass.
      const lines = formatReport([verdict({ kind: 'referenced', referencedBy: ['t.test.ts'] })]);
      expect(lines.join('\n')).not.toContain('CLEAN');
      expect(lines.at(-1)).toContain('1 referenced-only');
    });

    it('distinguishes "everything was exempt" from CLEAN', () => {
      // Nothing was examined, so there is nothing to be clean about.
      const lines = formatReport([
        verdict({ kind: 'exempt', reason: 'is a test' }, { path: 'tests/unit/a.test.ts' }),
      ]);
      expect(lines.join('\n')).not.toContain('CLEAN');
      expect(lines.at(-1)).toContain('no files in scope');
    });

    it('caps the named tests and says how many were left out', () => {
      const referencedBy = ['a', 'b', 'c', 'd', 'e'].map((n) => `tests/unit/${n}.test.ts`);
      const lines = formatReport([verdict({ kind: 'referenced', referencedBy })]);
      expect(lines.join('\n')).toContain('(+2 more)');
    });

    it('lists every verdict under --verbose, exempt ones included', () => {
      const lines = formatReport(
        [
          verdict({ kind: 'exempt', reason: 'is a test' }, { path: 'tests/unit/a.test.ts' }),
          verdict({ kind: 'covered', testPath: 't.test.ts', via: 'mirror' }),
        ],
        true
      );
      // The non-verbose report says nothing about either of these, which is why
      // a surprising verdict is otherwise unexplainable.
      expect(lines.join('\n')).toContain('tests/unit/a.test.ts — exempt: is a test');
      expect(lines.join('\n')).toContain('lib/a.ts — covered by t.test.ts (mirror)');
    });

    it('names the expected path for a missing file', () => {
      const lines = formatReport([
        verdict({ kind: 'missing', expected: ['tests/unit/lib/a.test.ts'] }),
      ]);
      expect(lines.join('\n')).toContain('tests/unit/lib/a.test.ts');
      expect(lines.at(-1)).toContain('1 missing');
    });
  });

  describe('uncommittedSources', () => {
    it('takes the destination of a rename, not the whole `old -> new` string', () => {
      // Asserted on the paths, not the count: the report prints a count only,
      // and a count cannot tell a rename parsed correctly from one parsed
      // whole. The first version of this test could not fail.
      gitReturns({ 'status --porcelain': 'R  lib/old.ts -> lib/new.ts\n?? lib/fresh.ts\n' });
      expect(uncommittedSources()).toEqual(['lib/new.ts', 'lib/fresh.ts']);
    });

    it('ignores a source file renamed INTO tests/', () => {
      // Taken whole the entry starts with `lib/`, so the `tests/` filter missed
      // it and a test file was counted as uncommitted source.
      gitReturns({ 'status --porcelain': 'R  lib/old.ts -> tests/unit/lib/old.test.ts\n' });
      expect(uncommittedSources()).toEqual([]);
    });

    it('is null — not empty — when git could not be asked', () => {
      gitReturns({ 'status --porcelain': new Error('not a git repository') });
      expect(uncommittedSources()).toBeNull();
    });
  });

  describe('makeReader', () => {
    it('reads a file inside the root', () => {
      write('lib/a.ts', 'export const x = 1;\n');
      expect(makeReader(dir)('lib/a.ts')).toContain('export const x');
    });

    it('refuses a path that escapes the root', () => {
      // The escape target must EXIST, or the clamp and a plain missing-file
      // both return null and the assertion cannot fail. It could not, the
      // first time this was written.
      const outside = join(dir, '..', `outside-${process.pid}.ts`);
      writeFileSync(outside, 'export const secret = 1;\n');
      try {
        expect(readFileSync(outside, 'utf8')).toContain('secret');
        expect(makeReader(dir)(`../outside-${process.pid}.ts`)).toBeNull();
      } finally {
        rmSync(outside, { force: true });
      }
    });

    it('returns null rather than throwing for a file that is not there', () => {
      expect(makeReader(dir)('lib/nope.ts')).toBeNull();
    });
  });

  describe('label', () => {
    it('marks a rename and leaves anything else alone', () => {
      expect(
        describeVerdict(verdict({ kind: 'missing', expected: [] }, { status: 'R' }))
      ).toContain('lib/a.ts (renamed)');
      expect(
        describeVerdict(verdict({ kind: 'missing', expected: [] }, { status: 'A' }))
      ).not.toContain('renamed');
    });
  });

  describe('describe (the --verbose line)', () => {
    it.each([
      [{ kind: 'exempt', reason: 'is a test' }, 'exempt: is a test'],
      [{ kind: 'covered', testPath: 't.test.ts', via: 'aspect' }, 'covered by t.test.ts (aspect)'],
      [{ kind: 'referenced', referencedBy: ['a.test.ts', 'b.test.ts'] }, 'referenced only, by 2'],
      [{ kind: 'missing', expected: [] }, 'MISSING'],
    ])('explains a %j verdict', (outcome, expected) => {
      // `--verbose` is what step 4f tells the reader to reach for when a verdict
      // surprises them, so every branch of it needs to say something true.
      expect(describeVerdict(verdict(outcome as Verdict['outcome']))).toContain(expected);
    });
  });

  describe('main — the paths that must not print a clean result', () => {
    it('refuses to run at all when the self-test fails', () => {
      mockSelfTestFailure.mockReturnValue('sentinel file was not reported');
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': 'A\tlib/a.ts\n' });
      write('tests/unit/lib/other.test.ts');

      expect(main([])).toBe(1);
      expect(logs.join('\n')).not.toContain('CLEAN');
      expect(errors.join('\n')).toContain('sentinel file was not reported');
    });

    it('fails when there is no base revision', () => {
      gitReturns({ 'merge-base': new Error('no upstream') });
      expect(main([])).toBe(1);
      expect(logs).toEqual([]);
      expect(errors.join('\n')).toContain('no base revision');
    });

    it('fails when git cannot list the diff', () => {
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': new Error('bad revision') });
      write('tests/unit/lib/a.test.ts');
      expect(main([])).toBe(1);
      expect(logs.join('\n')).not.toContain('CLEAN');
    });

    it('refuses to report at all when a changed path could not be read', () => {
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': 'A\t"weird\\tname.ts"\n' });
      write('tests/unit/lib/a.test.ts');

      expect(main([])).toBe(1);
      expect(errors.join('\n')).toContain('git returned them quoted');
      expect(logs.join('\n')).not.toContain('CLEAN');
    });

    it('asks git not to quote paths in the first place', () => {
      // Without `-c core.quotePath=false` every non-ASCII filename arrives
      // quoted and takes the branch above, so the check would refuse to run on
      // any repo with an accented filename.
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': '' });
      write('tests/unit/lib/a.test.ts');
      main([]);

      const diffCall = mockExecFileSync.mock.calls.find((call) =>
        (call[1] as string[]).includes('--name-status')
      );
      expect(diffCall?.[1]).toEqual(
        expect.arrayContaining(['-c', 'core.quotePath=false', 'diff', '--name-status'])
      );
    });

    it('fails when it can see no test files at all', () => {
      // The shape that matters most: with an empty index every file reads as
      // missing, so silently continuing would produce a confident, wrong report.
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': 'A\tlib/a.ts\n' });
      expect(main([])).toBe(1);
      expect(errors.join('\n')).toContain('no test files');
      expect(logs.join('\n')).not.toContain('CLEAN');
    });

    it.each([
      [['--base', ''], 'empty value'],
      [['--base', '--output=/tmp/x'], 'not an option'],
    ])('rejects %j', (argv, message) => {
      expect(main(argv)).toBe(1);
      expect(errors.join('\n')).toContain(message);
    });

    it('fails loudly on an explicitly requested base that does not exist', () => {
      // The caller named a revision, so falling back to the merge base would
      // answer a question they did not ask. It fails at `git diff`, carrying
      // git's own message — which is why there is no separate resolve step.
      gitReturns({ 'name-status': new Error('fatal: bad revision typo...HEAD') });
      write('tests/unit/lib/a.test.ts');

      expect(main(['--base', 'typo'])).toBe(1);
      expect(errors.join('\n')).toContain('Could not list changed files against "typo"');
      expect(errors.join('\n')).toContain('bad revision');
      expect(logs.join('\n')).not.toContain('CLEAN');
    });
  });

  describe('main — a run that could look', () => {
    beforeEach(() => {
      write('tests/unit/lib/covered.test.ts');
    });

    it('marks a rename, so a test that did not move with it reads as one', () => {
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': 'R100\tlib/old.ts\tlib/orphan.ts\n' });
      write('lib/orphan.ts', 'export const x = 1;\n');

      expect(main([])).toBe(0);
      expect(logs.join('\n')).toContain('lib/orphan.ts (renamed)');
    });

    it('reports a changed file with no test and still exits 0', () => {
      // Findings are a judgement for the reader, not a gate. Exit codes here
      // mean only "could this check run".
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': 'A\tlib/orphan.ts\n' });
      write('lib/orphan.ts', 'export const x = 1;\n');

      expect(main([])).toBe(0);
      expect(logs.join('\n')).toContain('lib/orphan.ts');
      expect(logs.join('\n')).toContain('1 missing');
    });

    it('is clean when the mirrored test exists', () => {
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': 'M\tlib/covered.ts\n' });
      write('lib/covered.ts', 'export const x = 1;\n');

      expect(main([])).toBe(0);
      expect(logs.join('\n')).toContain('CLEAN');
    });

    it('says so when nothing TypeScript changed', () => {
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': 'M\tREADME.md\n' });
      expect(main([])).toBe(0);
      expect(logs.join('\n')).toContain('no TypeScript files');
      expect(logs.join('\n')).not.toContain('CLEAN');
    });

    it('warns that uncommitted files were not scanned', () => {
      // The scan reads `base...HEAD`, so work in progress is invisible — which
      // is the state you are most likely in when running a pre-PR check.
      gitReturns({
        'merge-base': 'abc123\n',
        'name-status': 'M\tlib/covered.ts\n',
        'status --porcelain': '?? lib/brand-new.ts\n M lib/other.ts\n',
      });
      write('lib/covered.ts', 'export const x = 1;\n');

      expect(main([])).toBe(0);
      expect(logs.join('\n')).toContain('2 uncommitted');
    });

    it('says it could not check for uncommitted work rather than staying quiet', () => {
      // Silence here reads as "everything on disk was committed and scanned".
      // An earlier version returned [] on a git failure and printed nothing,
      // and the test locked that silence in.
      gitReturns({
        'merge-base': 'abc123\n',
        'name-status': 'M\tlib/covered.ts\n',
        'status --porcelain': new Error('not a git repository'),
      });
      write('lib/covered.ts', 'export const x = 1;\n');

      expect(main([])).toBe(0);
      expect(logs.join('\n')).toContain('could not check for uncommitted work');
      expect(logs.join('\n')).not.toMatch(/\d+ uncommitted/);
    });

    it('asks git not to quote paths when checking uncommitted work either', () => {
      gitReturns({ 'merge-base': 'abc123\n', 'name-status': '' });
      write('tests/unit/lib/a.test.ts');
      main([]);

      const statusCall = mockExecFileSync.mock.calls.find((call) =>
        (call[1] as string[]).includes('--porcelain')
      );
      expect(statusCall?.[1]).toEqual(
        expect.arrayContaining(['-c', 'core.quotePath=false', 'status'])
      );
    });

    it('--self-test reports without touching git', () => {
      expect(main(['--self-test'])).toBe(0);
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });
});
