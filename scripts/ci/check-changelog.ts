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

/** Runs git, returning `null` for any failure — missing repo, ref, or file. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
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

function printViolations(violations: ChangelogViolation[]): void {
  for (const violation of violations) {
    const location = violation.line > 0 ? `${CHANGELOG}:${violation.line}` : CHANGELOG;
    console.error(`  ${location}  ${violation.message}`);
  }
}

/** Returns the process exit code so every failure path is a plain `return`. */
function main(): number {
  const requested = parseBaseRef(process.argv.slice(2));
  if (requested.present && requested.ref === '') {
    console.error('`--base` needs a revision — got an empty value.');
    console.error('Omit the flag entirely to fall back to the merge base with origin/main.');
    return 1;
  }

  const changelog = readFileSync(resolve(process.cwd(), CHANGELOG), 'utf8');
  const violations = checkChangelogStructure(changelog, { sunriseVersion: SUNRISE_VERSION });

  // No explicit base: the merge base is the right comparison locally, because
  // `origin/main` on its own may carry a release the branch simply has not
  // merged yet — which is not a deletion.
  const base = requested.present
    ? requested.ref
    : git(['merge-base', 'origin/main', 'HEAD'])?.trim();
  const baseChangelog = base ? git(['show', `${base}:${CHANGELOG}`]) : null;

  if (baseChangelog !== null) {
    violations.push(...checkReleaseHistoryPreserved(baseChangelog, changelog));
  } else if (requested.present) {
    console.error(`Could not read ${CHANGELOG} at "${requested.ref}".`);
    console.error('Fetch the base revision before running this check.');
    return 1;
  }

  if (violations.length > 0) {
    console.error(
      `${CHANGELOG} has ${violations.length} structural problem${violations.length === 1 ? '' : 's'}:`
    );
    printViolations(violations);
    console.error('');
    console.error('See CONTRIBUTING.md "Cutting a release" for the heading conventions.');
    return 1;
  }

  const scope = baseChangelog !== null ? `structure + history vs ${base}` : 'structure';
  console.log(`${CHANGELOG} OK (${scope}).`);
  return 0;
}

const exitCode = main();
if (exitCode !== 0) process.exit(exitCode);
