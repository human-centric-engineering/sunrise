/**
 * Adds the happy-dom directive to tests that demonstrably need one.
 *
 * The migration aid for a fork merging Sunrise's node-by-default change. See
 * `scripts/ci/dom-tests.ts` for why this decides by running the tests rather
 * than by matching patterns, and `.context/testing/environments.md` for the
 * order to do a fork merge in.
 *
 * Usage:
 *   npm run fix:dom-tests                       # the whole suite
 *   npm run fix:dom-tests -- tests/unit/components
 *   npm run fix:dom-tests -- --dry-run          # print the plan, change nothing
 *   npx tsx scripts/ci/mark-dom-tests.ts --self-test
 *
 * Exit codes:
 *   0 — ran, and nothing is failing that this tool could not fix
 *   1 — could not run: self-test failed, vitest missing, output unreadable
 *   2 — ran, and real failures remain (they are listed; none of them are
 *       environment problems)
 *
 * THE GUARANTEE. A directive is written only for a file that **failed**, and it
 * is kept only if re-running that file with it turned the file green. Anything
 * else is reverted before this exits. Over-declaring is the silent direction —
 * a node test that picks up happy-dom passes while quietly reading the client
 * half of `lib/env.ts`'s schema — so "I added it and did not check" is not an
 * outcome this is allowed to have.
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

import {
  classify,
  domGlobalsMissingHere,
  selfTestFailure,
  withDirective,
  withoutDirective,
  type FailedFile,
} from '@/scripts/ci/dom-tests';
import { unsafeArgvPaths } from '@/scripts/ci/scoped-tests';

/** The vitest CLI entry point, or `null` if dependencies are not installed. */
export function vitestEntry(root: string): string | null {
  const entry = resolve(root, 'node_modules/vitest/vitest.mjs');
  return existsSync(entry) ? entry : null;
}

/** `typeof x === 'object'` narrowing that also rules out `null`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** What this tool needs from a vitest JSON report. */
export interface Report {
  /** Files that failed, with every message the reporter produced for them. */
  failed: FailedFile[];
  /** Repo-relative paths of files that **passed** — the only proof of green. */
  passed: Set<string>;
  /** `numTotalTestSuites`. Zero means the run collected nothing at all. */
  suites: number;
}

/**
 * Reads a vitest JSON report.
 *
 * Read with type guards rather than an `as` cast. The report is `JSON.parse`
 * output — external data by the repo's definition — and the rule in CLAUDE.md
 * is that it gets validated, not asserted. Zod would be the other half of that
 * rule but it is only a transitive dependency here; adding a direct one for a
 * migration script is a worse trade than four guards.
 *
 * Returns `null` when the report is not a shape this understands **at all**,
 * which the caller reports and exits on. The distinction matters: an empty
 * `failed` means "the suite failed and none of it was about the environment",
 * while `null` means "this tool could not look" — collapsing the two would let
 * an unreadable report print `0 files need a DOM` and read as good news.
 *
 * `passed` and `suites` exist because absence is not evidence. A path missing
 * from the failure list has not been shown to pass; it may simply not have run.
 * Both callers need to tell those apart — see `main`.
 *
 * Both failure shapes are handled and they arrive differently: a failure inside
 * a test lands in `assertionResults[].failureMessages`, while a failure while
 * *importing* the file lands in the file's own `message` with an empty
 * `assertionResults`. Reading only the first would miss every test whose
 * subject touches the DOM at module scope. Measured against vitest 4.1.10.
 */
export function readReport(report: unknown, root: string): Report | null {
  if (!isRecord(report)) return null;
  const results = report.testResults;
  if (!Array.isArray(results)) return null;

  const suitesValue = report.numTotalTestSuites;
  const suites = typeof suitesValue === 'number' ? suitesValue : 0;
  const failed: FailedFile[] = [];
  const passed = new Set<string>();

  for (const entry of results) {
    if (!isRecord(entry)) continue;
    const name = asString(entry.name);
    if (name === null) continue;

    // Clamp to the repo before reading, and therefore before writing: every
    // path here comes from a report on disk, and this tool's whole job is to
    // edit the files it names. `scripts/ci/check-missing-tests.ts` clamps its
    // reads the same way. Nothing is expected to escape — vitest reports files
    // inside the project — which is exactly when a guard costs nothing.
    const full = resolve(root, name);
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) continue;
    const path = relative(root, full).split(sep).join('/');

    const status = asString(entry.status);
    if (status === 'passed') {
      passed.add(path);
      continue;
    }
    if (status !== 'failed') continue;

    const messages: string[] = [];
    const message = asString(entry.message);
    if (message !== null && message.trim() !== '') messages.push(message);

    for (const assertion of asArray(entry.assertionResults)) {
      if (!isRecord(assertion)) continue;
      for (const failure of asArray(assertion.failureMessages)) {
        const text = asString(failure);
        if (text !== null) messages.push(text);
      }
    }

    let source = '';
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      // Unreadable is not "has no directive" — skip rather than risk writing a
      // second one into a file this cannot see.
      continue;
    }
    failed.push({ path, messages, source });
  }
  return { failed, passed, suites };
}

/** Runs vitest and returns its JSON report, or `null` if it could not be read. */
function runVitest(
  entry: string,
  root: string,
  targets: readonly string[]
): { report: unknown; ranClean: boolean } | null {
  const dir = mkdtempSync(join(tmpdir(), 'dom-tests-'));
  const outputFile = join(dir, 'report.json');
  try {
    const result = spawnSync(
      process.execPath,
      [entry, 'run', ...targets, '--reporter=json', `--outputFile=${outputFile}`],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
    );
    if (result.error !== undefined) return null;
    if (!existsSync(outputFile)) return null;
    return { report: JSON.parse(readFileSync(outputFile, 'utf8')), ranClean: result.status === 0 };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Returns the process exit code so every path out is a plain `return`. */
export function main(
  argv: string[],
  root: string = process.cwd(),
  selfTest: () => string | null = selfTestFailure
): number {
  const broken = selfTest();
  if (broken !== null) {
    console.error('Self-test failed — this tool cannot be trusted to classify a failure:');
    console.error(`  ${broken}`);
    console.error('Fix `scripts/ci/dom-tests.ts` before reading any result from it.');
    return 1;
  }
  if (argv.includes('--self-test')) {
    console.log('Self-test passed: the classifier separates DOM failures from real ones.');
    return 0;
  }

  const dryRun = argv.includes('--dry-run');

  // Reject an unrecognised flag rather than dropping it. This tool edits source
  // files, so `--dryrun` (a typo) silently taking the destructive path is not an
  // acceptable outcome — and a single-dash `-dry-run` would otherwise fall
  // through to `targets` and be handed to vitest as a filter matching nothing.
  const KNOWN = ['--dry-run', '--self-test'];
  const unknown = argv.filter((arg) => arg.startsWith('-') && !KNOWN.includes(arg));
  if (unknown.length > 0) {
    console.error(`Unrecognised option(s): ${unknown.join(', ')}`);
    console.error(`This tool takes ${KNOWN.join(', ')} and test paths. Nothing was changed.`);
    return 1;
  }

  const targets = argv.filter((arg) => !arg.startsWith('-'));

  const entry = vitestEntry(root);
  if (entry === null) {
    console.error('Could not find `node_modules/vitest/vitest.mjs` — run `npm ci` first.');
    return 1;
  }

  console.log(targets.length > 0 ? `Running ${targets.join(', ')}…` : 'Running the whole suite…');
  const first = runVitest(entry, root, targets);
  if (first === null) {
    console.error('Could not run vitest, or could not read its JSON report.');
    console.error('Nothing was changed. Run the suite yourself to see what it says.');
    return 1;
  }
  if (first.ranClean) {
    console.log('Everything passed — no test is missing a DOM. Nothing to do.');
    return 0;
  }

  const firstReport = readReport(first.report, root);
  if (firstReport === null) {
    console.error(
      'vitest reported a failure, but its JSON report is not a shape this understands.'
    );
    console.error('Nothing was changed. Treat this as "could not look", not "nothing to fix".');
    return 1;
  }

  // A run that collected NOTHING is not a clean tree. vitest exits 1 with
  // `numTotalTestSuites: 0` when positional filters match no file — a typo'd
  // path, or a fork whose components live somewhere other than the path the
  // docs suggest. Without this, the tool printed "No failure was caused by a
  // missing browser global" and exited 0 having run nothing at all: the exact
  // shape `scripts/ci/dom-tests.ts`'s header is written against, in the tool
  // itself.
  if (firstReport.suites === 0) {
    console.error('vitest collected no test files, so nothing ran.');
    if (targets.length > 0) {
      console.error(`Check the path(s): ${targets.join(', ')}`);
    }
    console.error('Nothing was changed. This is "could not look", not "nothing to fix".');
    return 1;
  }

  const verdict = classify(firstReport.failed, domGlobalsMissingHere());

  console.log('');
  console.log(`  need a DOM         ${verdict.candidates.length}`);
  console.log(`  already declared   ${verdict.alreadyDeclared.length}`);
  console.log(`  unrelated failures ${verdict.unrelated.length}`);
  console.log('');

  for (const { path, missing } of verdict.candidates) {
    console.log(`  + ${path}  (${missing.join(', ')})`);
  }

  if (verdict.candidates.length === 0) {
    console.log('  No failure was caused by a missing browser global.');
  }

  if (dryRun) {
    console.log('');
    console.log('--dry-run: nothing was written.');
    report(verdict.alreadyDeclared, verdict.unrelated);
    return verdict.unrelated.length + verdict.alreadyDeclared.length > 0 ? 2 : 0;
  }

  // Every write and every revert goes through this, so a throw part-way cannot
  // exit leaving unverified directives on disk with nothing said. Reverting is
  // where the stakes are highest — that is the path that undoes a claim this
  // tool could not support.
  const rewrite = (path: string, change: (source: string) => string | null): boolean => {
    const full = resolve(root, path);
    try {
      const updated = change(readFileSync(full, 'utf8'));
      if (updated === null) return false;
      writeFileSync(full, updated);
      return true;
    } catch (error) {
      console.error(`  ! could not rewrite ${path}: ${(error as Error).message}`);
      return false;
    }
  };

  const revertAll = (paths: readonly string[]): void => {
    for (const path of paths) rewrite(path, withoutDirective);
  };

  const written: string[] = [];
  for (const { path } of verdict.candidates) {
    if (rewrite(path, withDirective)) written.push(path);
  }

  if (written.length === 0) {
    report(verdict.alreadyDeclared, verdict.unrelated);
    return verdict.unrelated.length + verdict.alreadyDeclared.length > 0 ? 2 : 0;
  }

  // Reuse the scoped runner's refusal rather than a second copy of the rule:
  // these paths become positional argv for vitest, which reads options wherever
  // they appear, so a repo-root file named `-x.test.ts` would arrive as a flag.
  // `run-scoped-tests.ts` refuses rather than filters for the same reason, and
  // sharing the function is what keeps the two from drifting.
  const unsafeWritten = unsafeArgvPaths(written);
  if (unsafeWritten.length > 0) {
    console.error(
      `Cannot re-run ${unsafeWritten.length} path(s) safely: ${unsafeWritten.join(', ')}`
    );
    console.error('Reverting every directive, because none of them can be confirmed.');
    revertAll(written);
    return 1;
  }

  // THE GUARANTEE: keep a directive only if the file is now **shown to pass**.
  console.log('');
  console.log(`Re-running ${written.length} changed file(s) to confirm…`);
  const second = runVitest(entry, root, written);
  if (second === null) {
    console.error('Could not re-run the changed files, so the directives are unverified.');
    console.error('Reverting all of them rather than leaving a claim this cannot support.');
    revertAll(written);
    return 1;
  }

  const confirmation = readReport(second.report, root);
  if (confirmation === null) {
    // Same rule as above, and the stakes are higher here: an unreadable
    // confirmation means every directive just written is unverified.
    console.error('The confirming re-run produced a report this cannot read.');
    console.error('Reverting every directive rather than leaving a claim it cannot support.');
    revertAll(written);
    return 1;
  }

  // Confirmed by PRESENCE in the passed list, never by absence from the failed
  // one. A path missing from a report has not been shown to pass — it may
  // simply not have run, which is what an empty confirmation report looks like
  // when the paths match nothing (a fork whose vitest `root` is not the cwd).
  // Verifying by absence kept every directive and printed "confirmed by
  // re-running each" over a re-run that executed nothing.
  const reverted: string[] = [];
  for (const path of written) {
    if (confirmation.passed.has(path)) continue;
    if (rewrite(path, withoutDirective)) reverted.push(path);
  }

  const kept = written.filter((path) => !reverted.includes(path));
  console.log('');
  if (kept.length > 0) {
    console.log(`Added the directive to ${kept.length} file(s), each confirmed passing.`);
  }
  for (const path of reverted) {
    console.log(`  ! ${path} was not shown to pass with the directive — reverted.`);
  }

  report(verdict.alreadyDeclared, [...verdict.unrelated, ...reverted]);
  return verdict.unrelated.length + verdict.alreadyDeclared.length + reverted.length > 0 ? 2 : 0;
}

/** Prints what this tool deliberately did not touch. */
function report(
  alreadyDeclared: ReadonlyArray<{ path: string; environment: string }>,
  unrelated: readonly string[]
): void {
  if (alreadyDeclared.length > 0) {
    console.log('');
    console.log(
      'Already asking for an environment and still failing — not an environment problem:'
    );
    for (const { path, environment } of alreadyDeclared)
      console.log(`    ${path} (${environment})`);
  }
  if (unrelated.length > 0) {
    console.log('');
    console.log('Failing for reasons unrelated to the environment — left alone:');
    for (const path of unrelated.slice(0, 20)) console.log(`    ${path}`);
    if (unrelated.length > 20) console.log(`    (+${unrelated.length - 20} more)`);
    console.log('');
    console.log('  Node is stricter than happy-dom about `fetch` and `Response`, so some of');
    console.log('  these are real bugs the old environment was hiding. Sunrise found one:');
    console.log('  a 204 response built with a body, which undici rejects and happy-dom did not.');
  }
}

// Only when run as a CLI — see the same guard on `check-missing-tests.ts`.
if (process.argv[1] !== undefined && process.argv[1].endsWith('mark-dom-tests.ts')) {
  process.exitCode = main(process.argv.slice(2));
}
