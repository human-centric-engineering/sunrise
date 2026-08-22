/**
 * Tests for `npm run fix:dom-tests`.
 *
 * Driven against a scratch tree with a **stub vitest** that returns a scripted
 * JSON report, so the branches that matter can be reached deterministically.
 * Two of them a code review found, and both are the same shape: the tool
 * concluding something from an absence.
 *
 *   - a run that collected **nothing** (a typo'd path) used to read as "no
 *     failure was caused by a missing browser global", and exit 0
 *   - a confirming re-run that executed nothing used to read as "confirmed by
 *     re-running each", because verification tested for absence from the
 *     failure list rather than presence in the passed list
 *
 * Both are covered below, because both produced a cheerful green from a tool
 * that had not looked.
 *
 * @see scripts/ci/mark-dom-tests.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DIRECTIVE } from '@/scripts/ci/dom-tests';
import { main, readReport, vitestEntry } from '@/scripts/ci/mark-dom-tests';

/** Writes whichever report `scenario.json` names for this invocation. */
const STUB = `
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const out = (argv.find((a) => a.startsWith('--outputFile=')) ?? '').slice('--outputFile='.length);
const home = process.env.DOM_STUB_HOME;
const runsFile = join(home, 'runs.txt');
const runs = existsSync(runsFile) ? Number(readFileSync(runsFile, 'utf8')) : 0;
writeFileSync(runsFile, String(runs + 1));
if (process.env.DOM_STUB_NO_OUTPUT === '1') process.exit(1);
const scenario = JSON.parse(readFileSync(join(home, 'scenario.json'), 'utf8'));
const phase = runs === 0 ? scenario.first : scenario.second;
if (!phase) process.exit(0);
writeFileSync(out, JSON.stringify(phase.report));
process.exit(phase.status);
`;

let repo: string;

/** A report. `suites` defaults to 1, so "a report exists" means something ran. */
function reportOf(entries: unknown[], suites = Math.max(entries.length, 1)): unknown {
  return { numTotalTestSuites: suites, testResults: entries };
}

function failing(absolutePath: string, messages: string[], viaMessage = false): unknown {
  return viaMessage
    ? { name: absolutePath, status: 'failed', message: messages[0], assertionResults: [] }
    : {
        name: absolutePath,
        status: 'failed',
        message: '',
        assertionResults: [{ failureMessages: messages }],
      };
}

function passing(absolutePath: string): unknown {
  return { name: absolutePath, status: 'passed', message: '', assertionResults: [] };
}

function scenario(first: unknown, second?: unknown): void {
  writeFileSync(join(repo, 'scenario.json'), JSON.stringify({ first, second }));
  rmSync(join(repo, 'runs.txt'), { force: true });
}

function testFile(rel: string, body = 'const a = 1;\n'): string {
  const full = join(repo, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
  return full;
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'mark-dom-'));
  mkdirSync(join(repo, 'node_modules/vitest'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/vitest/vitest.mjs'), STUB);
  process.env.DOM_STUB_HOME = repo;
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  delete process.env.DOM_STUB_HOME;
  delete process.env.DOM_STUB_NO_OUTPUT;
});

beforeEach(() => {
  delete process.env.DOM_STUB_NO_OUTPUT;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('readReport', () => {
  it('reads assertion-level failures', () => {
    const full = testFile('tests/a.test.ts');
    const parsed = readReport(
      reportOf([failing(full, ['ReferenceError: document is not defined'])]),
      repo
    );
    expect(parsed?.failed).toHaveLength(1);
    expect(parsed?.failed[0].path).toBe('tests/a.test.ts');
    expect(parsed?.failed[0].messages[0]).toContain('document is not defined');
  });

  it('reads import-time failures, which have no assertionResults at all', () => {
    const full = testFile('tests/b.test.ts');
    const parsed = readReport(reportOf([failing(full, ['document is not defined'], true)]), repo);
    expect(parsed?.failed[0].messages).toEqual(['document is not defined']);
  });

  it('records a passing file, which is the only proof of green', () => {
    const full = testFile('tests/c.test.ts');
    const parsed = readReport(reportOf([passing(full)]), repo);
    expect(parsed?.failed).toEqual([]);
    expect(parsed?.passed.has('tests/c.test.ts')).toBe(true);
  });

  it('reports the suite count, so "nothing ran" is distinguishable', () => {
    expect(readReport(reportOf([], 0), repo)?.suites).toBe(0);
    expect(readReport(reportOf([], 7), repo)?.suites).toBe(7);
  });

  it('answers null — not an empty result — for a report it cannot understand', () => {
    // An empty `failed` means "the suite failed and none of it was about the
    // environment"; null means "this could not look". Collapsing them would let
    // an unreadable report print `0 files need a DOM` and read as good news.
    expect(readReport(null, repo)).toBeNull();
    expect(readReport({}, repo)).toBeNull();
    expect(readReport({ testResults: 'nope' }, repo)).toBeNull();
    expect(readReport(reportOf([]), repo)?.failed).toEqual([]);
  });

  it('skips a failing file it cannot read, rather than guessing it has no directive', () => {
    const report = reportOf([
      failing(join(repo, 'tests/gone.test.ts'), ['document is not defined']),
    ]);
    expect(readReport(report, repo)?.failed).toEqual([]);
  });

  it('ignores a reported path that escapes the repository', () => {
    // The tool edits the files a report names, so a path outside the root is one
    // it must not follow. Nothing is expected to produce one, which is exactly
    // when the guard is cheap.
    const outside = mkdtempSync(join(tmpdir(), 'mark-dom-outside-'));
    const stray = join(outside, 'escaped.test.ts');
    writeFileSync(stray, 'const a = 1;\n');
    const report = reportOf([failing(stray, ['ReferenceError: document is not defined'])]);
    expect(readReport(report, repo)?.failed).toEqual([]);
    expect(readFileSync(stray, 'utf8')).toBe('const a = 1;\n');
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('main', () => {
  it('passes its own self-test', () => {
    expect(main(['--self-test'], repo)).toBe(0);
  });

  it('refuses to run at all when the sentinel says the classifier is broken', () => {
    // The sentinel gates everything, `--self-test` included: reporting a plan
    // built by a classifier it had just found broken would be worse than not
    // checking.
    const broken = (): string => 'the matcher returned nothing';
    expect(main(['--self-test'], repo, broken)).toBe(1);
    expect(main([], repo, broken)).toBe(1);
  });

  it('reports a file it cannot rewrite instead of dying part-way', () => {
    // A read-only candidate. Without the guard, `writeFileSync` throws
    // uncaught and every directive written earlier in the loop stays on disk
    // with no re-run, no revert and no message.
    const full = testFile('tests/readonly.test.ts');
    chmodSync(full, 0o444);
    scenario({
      status: 1,
      report: reportOf([failing(full, ['ReferenceError: document is not defined'])]),
    });
    const error = vi.spyOn(console, 'error');
    expect(main([], repo)).toBe(0);
    expect(error.mock.calls.flat().join('\n')).toContain('could not rewrite');
    chmodSync(full, 0o644);
  });

  it('refuses when a candidate path would become a vitest option', () => {
    // Reuses the scoped runner's rule: a repo-root file named `-x.test.ts`
    // arrives as a flag, not a filter. Refuse rather than confirm nothing.
    const full = testFile('-dash.test.ts');
    scenario({
      status: 1,
      report: reportOf([failing(full, ['ReferenceError: document is not defined'])]),
    });
    const error = vi.spyOn(console, 'error');
    expect(main([], repo)).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('Cannot re-run');
    expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
    rmSync(full, { force: true });
  });

  it('reverts when the confirming report parses but is not a shape it knows', () => {
    const full = testFile('tests/bad-second.test.ts');
    scenario(
      { status: 1, report: reportOf([failing(full, ['ReferenceError: document is not defined'])]) },
      { status: 1, report: { notTestResults: [] } }
    );
    expect(main([], repo)).toBe(1);
    expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
  });

  it('refuses to run when the report is not valid JSON', () => {
    const originalStub = readFileSync(join(repo, 'node_modules/vitest/vitest.mjs'), 'utf8');
    writeFileSync(
      join(repo, 'node_modules/vitest/vitest.mjs'),
      `import { writeFileSync } from 'node:fs';
       const argv = process.argv.slice(2);
       const out = (argv.find((a) => a.startsWith('--outputFile=')) ?? '').slice('--outputFile='.length);
       writeFileSync(out, 'not json at all');
       process.exit(1);`
    );
    try {
      expect(main([], repo)).toBe(1);
    } finally {
      writeFileSync(join(repo, 'node_modules/vitest/vitest.mjs'), originalStub);
    }
  });

  it('refuses to run when vitest is not installed', () => {
    const bare = mkdtempSync(join(tmpdir(), 'mark-dom-bare-'));
    expect(main([], bare)).toBe(1);
    rmSync(bare, { recursive: true, force: true });
  });

  it('does nothing when the suite already passes', () => {
    scenario({ status: 0, report: reportOf([]) });
    expect(main([], repo)).toBe(0);
  });

  it('refuses a run that collected no test files', () => {
    // A typo'd path, or a fork whose components live elsewhere. vitest exits 1
    // with `numTotalTestSuites: 0`. This used to print "No failure was caused by
    // a missing browser global" and exit 0, having run nothing at all.
    const error = vi.spyOn(console, 'error');
    scenario({ status: 1, report: reportOf([], 0) });
    expect(main(['tests/typo'], repo)).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('collected no test files');
  });

  it('adds the directive to a file that failed on a missing browser global', () => {
    const full = testFile('tests/needs-dom.test.ts');
    scenario(
      { status: 1, report: reportOf([failing(full, ['ReferenceError: document is not defined'])]) },
      { status: 0, report: reportOf([passing(full)]) }
    );
    expect(main([], repo)).toBe(0);
    expect(readFileSync(full, 'utf8')).toBe(`${DIRECTIVE}\n\nconst a = 1;\n`);
  });

  it('reverts a directive when the re-run does not show the file passing', () => {
    const full = testFile('tests/still-broken.test.ts');
    scenario(
      { status: 1, report: reportOf([failing(full, ['ReferenceError: document is not defined'])]) },
      { status: 1, report: reportOf([failing(full, ['expected 1 to be 2'])]) }
    );
    expect(main([], repo)).toBe(2);
    expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
  });

  it('reverts when the confirming re-run executed nothing at all', () => {
    // The second hole a review found. Verification used to test for absence from
    // the failure list, so a re-run that collected nothing kept every directive
    // and reported "confirmed by re-running each".
    const full = testFile('tests/unconfirmed.test.ts');
    scenario(
      { status: 1, report: reportOf([failing(full, ['ReferenceError: document is not defined'])]) },
      { status: 1, report: reportOf([], 0) }
    );
    expect(main([], repo)).toBe(2);
    expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
  });

  it('leaves an unrelated failure alone and reports it', () => {
    const full = testFile('tests/real-bug.test.ts');
    scenario({ status: 1, report: reportOf([failing(full, ['expected 1 to be 2'])]) });
    expect(main([], repo)).toBe(2);
    expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
  });

  it('does not touch a file that already declares an environment', () => {
    const body = `${DIRECTIVE}\n\nconst a = 1;\n`;
    const full = testFile('tests/declared.test.ts', body);
    scenario({
      status: 1,
      report: reportOf([failing(full, ['ReferenceError: document is not defined'])]),
    });
    expect(main([], repo)).toBe(2);
    expect(readFileSync(full, 'utf8')).toBe(body);
  });

  it('writes nothing under --dry-run', () => {
    const full = testFile('tests/dry.test.ts');
    scenario({
      status: 1,
      report: reportOf([failing(full, ['ReferenceError: document is not defined'])]),
    });
    main(['--dry-run'], repo);
    expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
  });

  it('rejects an unrecognised flag rather than silently discarding it', () => {
    // `--dryrun` is a typo for `--dry-run`. Dropping it would take the
    // destructive path while the user believed they had asked for a preview.
    const full = testFile('tests/typo-flag.test.ts');
    scenario({
      status: 1,
      report: reportOf([failing(full, ['ReferenceError: document is not defined'])]),
    });
    expect(main(['--dryrun'], repo)).toBe(1);
    expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
  });

  it('rejects a single-dash argument rather than treating it as a path', () => {
    expect(main(['-dry-run'], repo)).toBe(1);
  });

  it('refuses to run when the report is unreadable but the suite failed', () => {
    scenario({ status: 1, report: { notTestResults: [], numTotalTestSuites: 1 } });
    expect(main([], repo)).toBe(1);
  });

  it('refuses to run when vitest produces no report at all', () => {
    process.env.DOM_STUB_NO_OUTPUT = '1';
    scenario({ status: 1, report: reportOf([]) });
    expect(main([], repo)).toBe(1);
  });

  it('forwards path arguments to vitest', () => {
    const full = testFile('tests/scoped.test.ts');
    scenario(
      { status: 1, report: reportOf([failing(full, ['ReferenceError: window is not defined'])]) },
      { status: 0, report: reportOf([passing(full)]) }
    );
    expect(main(['tests/scoped.test.ts'], repo)).toBe(0);
    expect(readFileSync(full, 'utf8')).toContain(DIRECTIVE);
  });

  it('reverts everything when the confirming re-run cannot be read', () => {
    // No verification means no claim: an unverified directive is worse than
    // none, because it looks like the tool checked.
    const full = testFile('tests/unverifiable.test.ts');
    scenario({
      status: 1,
      report: reportOf([failing(full, ['ReferenceError: document is not defined'])]),
    });
    const originalStub = readFileSync(join(repo, 'node_modules/vitest/vitest.mjs'), 'utf8');
    writeFileSync(
      join(repo, 'node_modules/vitest/vitest.mjs'),
      `import { writeFileSync, readFileSync, existsSync } from 'node:fs';
       import { join } from 'node:path';
       const home = process.env.DOM_STUB_HOME;
       const runsFile = join(home, 'runs.txt');
       const runs = existsSync(runsFile) ? Number(readFileSync(runsFile, 'utf8')) : 0;
       writeFileSync(runsFile, String(runs + 1));
       if (runs > 0) process.exit(1);           // second run writes no report
       const argv = process.argv.slice(2);
       const out = (argv.find((a) => a.startsWith('--outputFile=')) ?? '').slice('--outputFile='.length);
       writeFileSync(out, JSON.stringify(JSON.parse(readFileSync(join(home, 'scenario.json'), 'utf8')).first.report));
       process.exit(1);`
    );
    try {
      expect(main([], repo)).toBe(1);
      expect(readFileSync(full, 'utf8')).toBe('const a = 1;\n');
    } finally {
      // Restore even on failure: the scratch repo is shared, and a leaked
      // two-run stub would make every later test fail for reasons unrelated to
      // its subject, burying the real failure.
      writeFileSync(join(repo, 'node_modules/vitest/vitest.mjs'), originalStub);
    }
  });
});

describe('vitestEntry', () => {
  it('finds the entry point when dependencies are installed', () => {
    expect(vitestEntry(repo)).toBe(resolve(repo, 'node_modules/vitest/vitest.mjs'));
  });

  it('returns null rather than a path that does not exist', () => {
    const bare = mkdtempSync(join(tmpdir(), 'mark-dom-bare-'));
    expect(vitestEntry(bare)).toBeNull();
    expect(existsSync(join(bare, 'node_modules'))).toBe(false);
    rmSync(bare, { recursive: true, force: true });
  });
});
