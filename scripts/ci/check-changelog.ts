/**
 * CHANGELOG.md structure check.
 *
 * Reads `CHANGELOG.md` and `SUNRISE_VERSION`, applies the rules in
 * `scripts/ci/changelog-structure.ts`, prints every violation, and exits
 * non-zero if there were any.
 *
 * Usage:
 *   npm run check:changelog                 # static rules + auto-detected base
 *   npx tsx scripts/ci/check-changelog.ts --base origin/main
 *
 * The history rule needs a previous revision of the file to compare against.
 * With `--base <ref>` it uses that ref and treats an unreadable one as a hard
 * failure — CI passes the ref it has already fetched, so "I could not read it"
 * there means the wiring is broken, not that the check is inapplicable. With no
 * flag it falls back to the merge base with `origin/main` and **skips quietly**
 * when that is unavailable: `npm run validate` must work in a fresh clone with
 * no remote, on a detached HEAD, and inside a fork whose upstream is named
 * something else. CI is where this rule is enforced; locally it is a courtesy.
 *
 * Printing goes through `console`, not `logger`: this is an operator-facing CLI
 * and structured JSON would bury the one line that says what to fix. See the
 * `scripts/**` override in `eslint.config.mjs`, which turns `no-console` off
 * here for exactly that reason.
 *
 * @see scripts/ci/changelog-structure.ts — the rules, and why each exists
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SUNRISE_VERSION } from '@/lib/sunrise-version';
import {
  checkChangelogStructure,
  checkReleaseHistoryPreserved,
  type ChangelogViolation,
} from '@/scripts/ci/changelog-structure';

const CHANGELOG = 'CHANGELOG.md';

/**
 * The last git failure, so the caller can say *why* rather than guess.
 *
 * Without this, "git is not installed", "that ref is not here", and "the output
 * exceeded maxBuffer" all rendered as the same "fetch the base revision" advice
 * — right for one of the three.
 */
let lastGitError = '';

/**
 * git's own first line of complaint, falling back to the thrown message.
 *
 * `execFileSync` is called with `encoding: 'utf8'`, so `stderr` on the thrown
 * error is a string when it is present at all.
 */
function describeGitFailure(error: unknown): string {
  const stderr =
    typeof error === 'object' && error !== null && 'stderr' in error ? error.stderr : undefined;
  const text =
    typeof stderr === 'string' && stderr.trim() !== ''
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return text.split('\n')[0].trim();
}

/** Runs git, returning `null` for any failure — missing repo, ref, or file. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // `git show <ref>:CHANGELOG.md` prints the whole file. Node's default cap
      // is 1 MiB and this changelog passed 140 KB at ten releases, ~60 KB of it
      // in 0.8.0 alone — so the default is roughly a dozen releases from
      // failing on every PR, with a message pointing at the fetch wiring rather
      // than at the buffer. Cheaper to not have that conversation later.
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    lastGitError = describeGitFailure(error);
    return null;
  }
}

/**
 * `--base <ref>` or `--base=<ref>`.
 *
 * `present` is tracked separately from the value because the two carry
 * different contracts: an absent flag means "compare if you can", while a
 * present one means "compare, and fail if you cannot". Collapsing them onto
 * truthiness turns `--base ""` — a wrapper interpolating an unset variable —
 * into a silent skip that still exits 0, which is the one outcome a check
 * against silent damage must never produce.
 */
function parseBaseRef(argv: string[]): { present: boolean; ref: string } {
  const index = argv.indexOf('--base');
  if (index !== -1) return { present: true, ref: argv[index + 1] ?? '' };
  const inline = argv.find((arg) => arg.startsWith('--base='));
  if (inline !== undefined) return { present: true, ref: inline.slice('--base='.length) };
  return { present: false, ref: '' };
}

/** Prints the accumulated findings, if any. Returns whether it printed. */
function reportViolations(violations: ChangelogViolation[]): boolean {
  if (violations.length === 0) return false;

  console.error(
    `${CHANGELOG} has ${violations.length} structural problem${violations.length === 1 ? '' : 's'}:`
  );
  for (const violation of violations) {
    const location = violation.line > 0 ? `${CHANGELOG}:${violation.line}` : CHANGELOG;
    console.error(`  ${location}  ${violation.message}`);
  }
  console.error('');
  console.error('See CONTRIBUTING.md "Cutting a release" for the heading conventions.');
  return true;
}

/** Returns the process exit code so every failure path is a plain `return`. */
function main(): number {
  const requested = parseBaseRef(process.argv.slice(2));
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
    console.error('Omit the flag entirely to fall back to the merge base with origin/main.');
    return 1;
  }

  const path = resolve(process.cwd(), CHANGELOG);
  let changelog: string;
  try {
    changelog = readFileSync(path, 'utf8');
  } catch (error) {
    // This is the first link in `npm run validate`, so an unhandled throw here
    // aborts the whole chain with a stack trace before type-check even starts.
    console.error(`Could not read ${path}`);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const violations = checkChangelogStructure(changelog, { sunriseVersion: SUNRISE_VERSION });

  // No explicit base: the merge base is the right comparison locally, because
  // `origin/main` on its own may carry a release the branch simply has not
  // merged yet — which is not a deletion.
  const base = requested.present
    ? requested.ref
    : git(['merge-base', 'origin/main', 'HEAD'])?.trim();
  const baseChangelog = base ? git(['show', `${base}:${CHANGELOG}`]) : null;

  let historyScope = 'structure';
  if (baseChangelog !== null) {
    const history = checkReleaseHistoryPreserved(baseChangelog, changelog);
    violations.push(...history.violations);
    if (history.skipped === 'base-truncated') {
      // Not a violation — the damage is on a revision this contributor did not
      // write. But the rule did not run, and reporting a clean comparison it
      // never made is the exact failure this check exists to prevent. Under
      // Actions a plain stderr line would sit unread inside a green step, so
      // it goes out as a warning annotation.
      const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::warning::' : 'Note: ';
      console.error(
        `${prefix}skipped the append-only comparison — ${CHANGELOG} at ${base} has an unclosed code fence or HTML comment, so its release list cannot be read in full.`
      );
      historyScope = `structure (history vs ${base} skipped)`;
    } else if (history.skipped === null) {
      historyScope = `structure + history vs ${base}`;
    }
    // 'head-truncated' leaves the scope at 'structure': the unclosed fence or
    // comment is already among the violations below, so the run fails and says
    // why.
  } else if (requested.present) {
    // Print what we already found first. A base-fetch problem and a broken
    // CHANGELOG can arrive together, and throwing away the actionable half
    // costs the contributor a whole round trip.
    reportViolations(violations);
    console.error(`Could not read ${CHANGELOG} at "${requested.ref}".`);
    // Unconditional: reaching here means `git show` ran and failed, so there is
    // always something to report. A guard would only hide the case where git
    // said nothing, which is itself worth seeing.
    console.error(`git: ${lastGitError}`);
    console.error('Fetch the base revision before running this check.');
    return 1;
  }

  if (reportViolations(violations)) return 1;

  console.log(`${CHANGELOG} OK (${historyScope}).`);
  return 0;
}

// `process.exitCode`, not `process.exit()`. stderr is asynchronous when it is a
// pipe — which it is under both `npm run` and GitHub Actions — and
// `process.exit()` discards whatever is still queued. A check whose failure
// message can vanish is worse than no check. Nothing keeps the loop alive after
// `main()` returns, so setting the code is equivalent and safe.
process.exitCode = main();
