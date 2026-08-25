/**
 * Scoped test run — the CLI behind `npm run test:changed`.
 *
 * Runs the tests this branch can affect, plus the whole-tree invariants no
 * module graph reaches, and (with `--coverage`) gates coverage on the changed
 * source files rather than on the repo average.
 *
 * Usage:
 *   npm run test:changed
 *   npm run test:changed:coverage
 *   npm run test:changed -- --reporter=dot        # unknown flags go to vitest
 *   npx tsx scripts/ci/run-scoped-tests.ts --base <merge-base> --coverage
 *   npx tsx scripts/ci/run-scoped-tests.ts --dry-run      # print the plan, run nothing
 *   npx tsx scripts/ci/run-scoped-tests.ts --self-test
 *
 * Any argument this runner does not recognise is forwarded to vitest — see
 * {@link splitArgv} for why that is not gated on a `--` separator.
 *
 * Pass `--base` a **merge base**, not a branch tip: {@link changedPaths}
 * mirrors vitest's three-dot resolution, and the two only agree there.
 *
 * Exit codes:
 *   whatever vitest exited with — when the run happened
 *   1 — could not run: self-test failed, no base, git failed, vitest list failed
 *
 * THE STALE-BASE HOLE, AND WHY THIS FETCHES BY DEFAULT
 * Every scoped run is only as honest as its base ref. A stale `origin/main`
 * produces a short changed-file list, a short list produces a small test
 * selection, and a small selection passes quickly — the failure looks exactly
 * like success, which is the same shape as CI's truncated-file-list bug
 * (`.context/architecture/ci.md`). `git fetch origin main --quiet` costs about
 * a second and removes the hole at its source, so it is the default and
 * `--no-fetch` is the opt-out rather than the other way round. A fetch that
 * fails is reported and the run continues against whatever ref is local — an
 * offline laptop should still be able to run its tests, it just gets told what
 * it is comparing against.
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 *
 * @see scripts/ci/scoped-tests.ts — the pure half, and the reasoning
 * @see .context/testing/scoped-runs.md
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ALWAYS_RUN_TESTS,
  alwaysRunPaths,
  buildVitestArgv,
  coverageTargets,
  selfTestFailure,
  undeclaredRepoRootedTests,
  unsafeArgvPaths,
} from '@/scripts/ci/scoped-tests';
import { listTestFiles, makeReader, parseBaseRef } from '@/scripts/ci/check-missing-tests';

/** The coverage floor, kept equal to `vitest.config.ts`'s global thresholds. */
const COVERAGE_THRESHOLD = 80;

let lastGitError = '';

/**
 * The first useful line of whatever `execFileSync` threw.
 *
 * git puts the real diagnosis on stderr and Node's own `Error.message` only
 * repeats the command line, so stderr wins when it has anything in it.
 * Exported because the three fallbacks below are otherwise only reachable by
 * arranging for git to fail in three different ways.
 */
export function gitErrorMessage(error: unknown): string {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : undefined;
  const raw =
    typeof stderr === 'string' && stderr.trim() !== ''
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.split('\n')[0].trim();
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    lastGitError = gitErrorMessage(error);
    return null;
  }
}

/** Lines of `git` output as a trimmed, empty-free list. Exported for its test. */
export function lines(output: string | null): string[] {
  if (output === null) return [];
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * Changed paths, resolved **exactly the way vitest resolves them**.
 *
 * This deliberately mirrors vitest's `GitVCSProvider` rather than expressing
 * the same idea a second way: `<base>...HEAD` (three-dot), plus `--cached` for
 * staged work, plus `ls-files --others --modified` for everything in the
 * working tree. Uncommitted and untracked files stay in scope, which is what a
 * pre-commit gate needs.
 *
 * **The two lists must agree, and only the same commands guarantee that.** The
 * first version used two-dot `git diff <base>`, which is equivalent only while
 * `base` is the merge base. Pass `--base origin/main` on a branch whose `main`
 * has moved on — the usage line in this file's own header used to suggest
 * exactly that — and two-dot reports files changed *on main* as changed here.
 * They would land in the coverage list and be held to an 80% floor while
 * vitest's three-dot selection never picked up their tests, so the run fails at
 * 0% on files the branch never touched. Mirroring removes the class of bug
 * rather than the instance.
 */
export function changedPaths(base: string, cwd: string): { paths: string[]; failed: boolean } {
  const quiet = ['-C', cwd, '-c', 'core.quotePath=false'];
  const since = git([...quiet, 'diff', '--name-only', `${base}...HEAD`]);
  if (since === null) return { paths: [], failed: true };
  const staged = git([...quiet, 'diff', '--cached', '--name-only']);
  if (staged === null) return { paths: [], failed: true };
  const working = git([...quiet, 'ls-files', '--others', '--modified', '--exclude-standard']);
  if (working === null) return { paths: [], failed: true };
  return {
    paths: [...new Set([...lines(since), ...lines(staged), ...lines(working)])].sort(),
    failed: false,
  };
}

/**
 * The changed paths this branch actually **authored**, which is what the
 * per-file coverage floor is entitled to ask about.
 *
 * {@link changedPaths} answers "what does this branch touch" and is right for
 * test *selection*: a sync merge really can break upstream's tests, and those
 * tests should run. It is the wrong question for the coverage *floor*, which
 * asks "is what you changed tested". On a sync merge the answer is that the
 * fork changed nothing — every file in the diff was written upstream — so the
 * floor was demanding a fork either fail its own gate or write tests for
 * platform code it does not own, and `CUSTOMIZATION.md` asks it to do neither
 * (#671).
 *
 * Measured on this tree at the time of writing: a fork syncing from v0.9.0 hit
 * 6 such files, from v0.7.0 about 15, from v0.5.0 about 16 — the count grows
 * with the distance from the fork point, so the friction is worst for exactly
 * the forks with the most merging to do.
 *
 * Authorship is read off git's own history rather than inferred: commits on
 * the branch's **first-parent line, excluding merges**. A merge contributes
 * nothing, so a pure sync merge authors nothing; an ordinary feature branch
 * has no merges and authors all of it, leaving that gate exactly as strict as
 * before. Staged and working-tree files are always included — uncommitted work
 * is by definition yours.
 *
 * **Known trade-off.** Writing code on one branch and merging it into another
 * before opening the PR moves those files out of the floor's reach. That is a
 * deliberate evasion rather than a thing anyone does by accident, the full
 * suite still runs in CI either way, and the alternative — the gate being
 * wrong for every fork on every sync — is a cost paid constantly by people who
 * did nothing wrong.
 */
export function authoredPaths(base: string, cwd: string): { paths: string[]; failed: boolean } {
  const quiet = ['-C', cwd, '-c', 'core.quotePath=false'];
  const own = git([
    ...quiet,
    'log',
    '--first-parent',
    '--no-merges',
    '--name-only',
    '--pretty=format:',
    `${base}..HEAD`,
  ]);
  if (own === null) return { paths: [], failed: true };
  const staged = git([...quiet, 'diff', '--cached', '--name-only']);
  if (staged === null) return { paths: [], failed: true };
  const working = git([...quiet, 'ls-files', '--others', '--modified', '--exclude-standard']);
  if (working === null) return { paths: [], failed: true };
  return {
    paths: [...new Set([...lines(own), ...lines(staged), ...lines(working)])].sort(),
    failed: false,
  };
}

/** The vitest CLI entry point, or `null` if dependencies are not installed. */
export function vitestEntry(root: string): string | null {
  const entry = resolve(root, 'node_modules/vitest/vitest.mjs');
  return existsSync(entry) ? entry : null;
}

/**
 * Asks vitest which test files the changed set reaches.
 *
 * Uses vitest's own `--changed` rather than reimplementing the module-graph
 * walk, so the selection here and the selection CI's `test-changed` job makes
 * are the same code. `--filesOnly` prints one repo-relative path per line and
 * runs nothing; measured at 1.8s on this tree for a small diff.
 */
export function selectChangedTests(
  entry: string,
  base: string,
  cwd: string
): { files: string[]; failed: boolean; stderr: string; unrecognised: string[] } {
  const result = spawnSync(process.execPath, [entry, 'list', '--filesOnly', '--changed', base], {
    encoding: 'utf8',
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return { files: [], failed: true, stderr: (result.stderr ?? '').trim(), unrecognised: [] };
  }

  // Keep a line if it names a file that exists; collect the rest for the
  // caller to complain about.
  //
  // The first version filtered on `.test.ts` / `.test.tsx`, which is narrower
  // than `vitest.config.ts`'s own include glob — that also matches `.spec.*`,
  // `.test.js`, `.test.mts` and more, so a fork's `.spec.ts` files were dropped
  // from the selection without a word. And when a config declares `projects`,
  // vitest prefixes each line with `[name] `, which still ends in `.test.ts`
  // and would have been handed straight to vitest as a filter matching nothing.
  // Both shorten the run in silence, and the always-run files keep it non-empty
  // so vitest still exits 0. Existence is the property that actually matters
  // here — these strings are about to become file filters — and it is the one
  // that does not have to track vitest's glob.
  const files: string[] = [];
  const unrecognised: string[] = [];
  for (const line of lines(result.stdout)) {
    if (existsSync(resolve(cwd, line))) files.push(line);
    else unrecognised.push(line);
  }
  return { files, failed: false, stderr: '', unrecognised };
}

/** Flags this runner consumes. Anything else is vitest's. */
const OWN_FLAGS = ['--coverage', '--dry-run', '--no-fetch', '--self-test', '--base'];

/**
 * Splits argv into this runner's flags and vitest's.
 *
 * **Anything unrecognised is forwarded**, rather than requiring a `--`
 * separator, because npm eats the separator before the script ever sees it:
 * `npm run test:changed -- --reporter=dot` delivers `['--reporter=dot']`, with
 * no `--` left in argv. The first version looked for that `--`, found none,
 * forwarded nothing, and ignored the flag without a word — so both examples in
 * `.context/testing/scoped-runs.md` were wrong, and the test that "covered"
 * this called `main` with a `--` no npm user can produce.
 *
 * An explicit `--` is still honoured for the case where a vitest flag collides
 * with one of {@link OWN_FLAGS} — `-- --coverage` asks vitest for a plain
 * coverage report without this runner building a scoped include list.
 *
 * A mistyped runner flag now reaches vitest, which rejects unknown options
 * loudly. That is the right failure: a stranger is refused by somebody, rather
 * than dropped by everybody.
 */
export function splitArgv(argv: readonly string[]): { own: string[]; forwarded: string[] } {
  const separator = argv.indexOf('--');
  const head = separator === -1 ? [...argv] : argv.slice(0, separator);
  const explicit = separator === -1 ? [] : argv.slice(separator + 1);

  const own: string[] = [];
  const forwarded: string[] = [...explicit];
  for (let i = 0; i < head.length; i += 1) {
    const arg = head[i];
    if (arg === '--base') {
      own.push(arg);
      if (i + 1 < head.length) {
        own.push(head[i + 1]);
        i += 1;
      }
      continue;
    }
    if (OWN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))) own.push(arg);
    else forwarded.push(arg);
  }
  return { own, forwarded };
}

/**
 * Returns the process exit code so every path out is a plain `return`.
 *
 * `root` is injected rather than read from `process.cwd()` inside, so the test
 * can drive a scratch repository without `process.chdir` — which vitest shares
 * across every test in a worker and which leaks into whatever runs next.
 */
export function main(
  argv: string[],
  root: string = process.cwd(),
  selfTest: () => string | null = selfTestFailure
): number {
  // The sentinel runs first, always, before anything can print a plan.
  const broken = selfTest();
  if (broken !== null) {
    console.error('Self-test failed — this runner cannot be trusted to select tests:');
    console.error(`  ${broken}`);
    console.error('Fix `scripts/ci/scoped-tests.ts` before reading any result from it.');
    return 1;
  }
  if (argv.includes('--self-test')) {
    console.log('Self-test passed: the always-run list and the advisory detector both answer.');
    return 0;
  }

  const { own, forwarded } = splitArgv(argv);

  const wantsCoverage = own.includes('--coverage');
  const dryRun = own.includes('--dry-run');

  const entry = vitestEntry(root);
  if (entry === null) {
    console.error('Could not find `node_modules/vitest/vitest.mjs` — run `npm ci` first.');
    console.error(`Looked under ${root}.`);
    return 1;
  }

  const requested = parseBaseRef(own);
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
    return 1;
  }
  if (requested.present && requested.ref.startsWith('-')) {
    console.error(`\`--base\` must be a revision, not an option: "${requested.ref}".`);
    return 1;
  }

  if (!requested.present && !own.includes('--no-fetch')) {
    if (git(['-C', root, 'fetch', 'origin', 'main', '--quiet']) === null) {
      console.warn(`Could not fetch origin/main (${lastGitError}).`);
      console.warn('Comparing against the local ref, which may be behind.');
    }
  }

  const base = requested.present
    ? requested.ref
    : git(['-C', root, 'merge-base', 'origin/main', 'HEAD'])?.trim();
  if (!base) {
    // Not "nothing changed": a run that cannot establish what changed has no
    // opinion about this branch, and running a token handful of tests while
    // printing a pass is how a blind gate gets mistaken for a clean one.
    console.error('Could not run — no base revision available.');
    console.error('Run `git fetch origin main` and re-run, or pass `--base <ref>`.');
    return 1;
  }

  const { paths, failed } = changedPaths(base, root);
  if (failed) {
    console.error(`Could not list changed files against "${base}".`);
    console.error(`git: ${lastGitError}`);
    return 1;
  }

  const selection = selectChangedTests(entry, base, root);
  if (selection.failed) {
    console.error(`\`vitest list --changed ${base}\` failed, so the selection is unknown.`);
    if (selection.stderr !== '') console.error(selection.stderr);
    console.error('Refusing to run a partial selection and report it as a scoped run.');
    return 1;
  }

  if (selection.unrecognised.length > 0) {
    console.error(
      `\`vitest list\` printed ${selection.unrecognised.length} line(s) that are not files in this tree:`
    );
    for (const line of selection.unrecognised) console.error(`  ${JSON.stringify(line)}`);
    console.error('The selection cannot be trusted, so nothing was run. A `projects` config');
    console.error('prefixes each line with `[name] `; a newline in a filename splits one.');
    return 1;
  }

  // A listed invariant that is absent from this tree is reported, not skipped
  // in silence — in a fork it means the test was deleted or moved, and the
  // entry needs removing with a reason rather than rotting into a no-op.
  const alwaysRun = alwaysRunPaths().filter((path) => existsSync(resolve(root, path)));
  const missingAlways = alwaysRunPaths().filter((path) => !alwaysRun.includes(path));

  // The floor lands on what this branch authored, not on what a merge dragged
  // in — see `authoredPaths`. Selection above still uses the full diff, so a
  // sync merge runs every test it can affect; only the 80% floor narrows.
  //
  // If git cannot answer, gate the full diff as before. That is the stricter
  // reading, and a gate that quietly stops gating is worse than one that asks
  // too much.
  let gateable = paths;
  let notAuthored = 0;
  if (wantsCoverage) {
    const authored = authoredPaths(base, root);
    if (authored.failed) {
      console.warn(`Could not tell which files this branch authored (${lastGitError}).`);
      console.warn('Holding every changed file to the coverage floor, which may over-ask.');
    } else {
      const own = new Set(authored.paths);
      gateable = paths.filter((path) => own.has(path));
      notAuthored = paths.length - gateable.length;
    }
  }

  // Deleted paths are in the diff and must not be gated: `--coverage.include`
  // for a file that no longer exists matches nothing, so it would inflate the
  // printed count while gating nothing.
  const coverage = wantsCoverage
    ? coverageTargets(gateable).filter((path) => existsSync(resolve(root, path)))
    : [];

  // Refuse rather than filter, and only for the paths that actually become
  // argv — the selected tests and the coverage targets. Applying this to every
  // changed path aborted the whole run over an unrelated `-draft.md` that was
  // never going to be handed to vitest at all.
  const unsafe = [...unsafeArgvPaths(selection.files), ...unsafeArgvPaths(coverage)];
  if (unsafe.length > 0) {
    console.error(`Refusing to run: ${unsafe.length} path(s) cannot be passed to vitest safely.`);
    for (const path of unsafe) console.error(`  ${JSON.stringify(path)}`);
    console.error('A leading dash, a git C-quoted path, or a control character in a filename');
    console.error('does this. Rename the file; nothing was run.');
    return 1;
  }

  // A C-quoted TypeScript path is the one shape the coverage filter cannot see:
  // git quotes it, so it stops ending in `.ts` and `coverageTargets` drops it
  // without a word. Caught here rather than there so the message can say what
  // happened — the same call `check-missing-tests.ts` makes for the same reason.
  //
  // Only when coverage was asked for. The justification is entirely about the
  // coverage gate, so applying it to a plain `test:changed` bricked the run
  // over an unrelated repo file with a tab in its name and no gate to drop out
  // of — a refusal wider than its own reason.
  const quotedSources = wantsCoverage
    ? paths.filter(
        (path) => path.startsWith('"') && (path.endsWith('.ts"') || path.endsWith('.tsx"'))
      )
    : [];
  if (quotedSources.length > 0) {
    console.error(`Could not read ${quotedSources.length} changed TypeScript path(s):`);
    for (const path of quotedSources) console.error(`  ${path}`);
    console.error('git C-quotes a filename containing a tab, newline or quote. Nothing was run,');
    console.error('because these would drop out of the coverage gate in silence.');
    return 1;
  }
  const plan = { selected: selection.files, alwaysRun, coverage, threshold: COVERAGE_THRESHOLD };
  const vitestArgv = [...buildVitestArgv(plan), ...forwarded];
  const total = new Set([...selection.files, ...alwaysRun]).size;

  // An empty union must not reach vitest. `vitest run` with no file filters
  // runs the WHOLE suite, so "nothing to run" would silently become "run
  // everything" — under a `--coverage.include` scoped to the changed files, so
  // the reported numbers would mislead too. Upstream this is unreachable
  // (ALWAYS_RUN_TESTS is never empty), but a fork that deleted Sunrise's
  // whole-tree tests gets warned about each missing entry and carries on, and
  // a docs-only diff then lands exactly here.
  if (total === 0) {
    console.log(`Scoped run vs ${base}: nothing to run.`);
    console.log(`  ${paths.length} changed path(s) reach no test, and no always-run test exists.`);
    console.log('  Not a full-suite run — `vitest run` with no filters would be one.');
    return 0;
  }

  console.log(`Scoped run vs ${base}`);
  console.log(`  changed paths     ${paths.length}`);
  if (notAuthored > 0) {
    console.log(
      `  not authored here ${notAuthored} (from a merge — not held to the coverage floor)`
    );
  }
  console.log(`  tests selected    ${selection.files.length} by module graph`);
  console.log(`  always-run added  ${alwaysRun.length - countOverlap(selection.files, alwaysRun)}`);
  console.log(`  test files to run ${total}`);
  if (wantsCoverage) {
    // "requested for", not "gated on". `vitest.config.ts`'s own `coverage.exclude`
    // still applies over these includes, so `lib/env.ts`, `types/**`, `emails/**`
    // and the App Router boundary files are asked for and then dropped by the
    // reporter. Saying "gated on N" would claim a floor that a branch touching
    // only excluded files does not actually get.
    console.log(
      `  coverage requested ${coverage.length} changed source file(s), ≥${COVERAGE_THRESHOLD}% each`
    );
    console.log("                    (vitest.config.ts's coverage.exclude may drop some)");
    if (coverage.length === 0) {
      console.log('    (no TypeScript sources changed — nothing to gate)');
    }
  }

  for (const path of missingAlways) {
    console.warn(`  ! always-run entry not found in this tree: ${path}`);
    console.warn('    Remove it from ALWAYS_RUN_TESTS with a reason, or restore the test.');
  }

  reportUndeclared(root);

  if (dryRun) {
    console.log('');
    console.log(
      `--dry-run: would run vitest ${vitestArgv.slice(0, 1).join(' ')} with ${total} file(s).`
    );
    return 0;
  }

  console.log('');
  const run = spawnSync(process.execPath, [entry, ...vitestArgv], { stdio: 'inherit', cwd: root });
  if (run.error !== undefined) {
    console.error(`Could not start vitest: ${run.error.message}`);
    return 1;
  }
  // A signal death (OOM, Ctrl-C) leaves `status` null. Reporting 0 there would
  // turn a killed run into a pass, which is the `cancelled`-vs-`failure` hole
  // `ci-status` had.
  if (run.status === null) {
    console.error(`vitest was terminated by ${run.signal ?? 'an unknown signal'} — no result.`);
    return 1;
  }
  return run.status;
}

export function countOverlap(a: readonly string[], b: readonly string[]): number {
  const set = new Set(a);
  return b.filter((path) => set.has(path)).length;
}

/**
 * Prints tests that read the repo root but are not declared always-run.
 *
 * Advisory, and labelled as such where it prints — see the header of
 * `scripts/ci/scoped-tests.ts` for why this cannot be a gate. Failing to read
 * the tree here is reported too: an empty list from a scan that could not look
 * is the exact thing #641 was about.
 */
export function reportUndeclared(root: string): void {
  const testFiles = listTestFiles(root);
  if (testFiles.length === 0) {
    console.warn('  ! found no test files under `tests/` — could not check for undeclared');
    console.warn('    whole-tree tests. Is this the repo root?');
    return;
  }
  const undeclared = undeclaredRepoRootedTests(testFiles, makeReader(root));
  if (undeclared.length === 0) return;
  console.log('');
  console.log(
    `  Advisory: ${undeclared.length} test(s) read from the repo root but are not in ` +
      `ALWAYS_RUN_TESTS (${ALWAYS_RUN_TESTS.length} declared).`
  );
  console.log('  A scoped run only reaches these when the module graph happens to select them.');
  console.log('  Some belong on the list. Some root a temp fixture at cwd and are fine as-is,');
  console.log('  and a test *about* tree-reading matches on its own fixture strings.');
  for (const path of undeclared.slice(0, 10)) console.log(`    ${path}`);
  if (undeclared.length > 10) console.log(`    (+${undeclared.length - 10} more)`);
}

// Only when run as a CLI — see the same guard on `check-missing-tests.ts`.
if (process.argv[1] !== undefined && process.argv[1].endsWith('run-scoped-tests.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
