/**
 * `[Unreleased]` staleness rules — pure, no IO.
 *
 * `/pre-pr` step 5d asks whether a public-surface change is *missing* a
 * CHANGELOG entry, and explicitly stops there: "If `CHANGELOG.md` IS in the
 * diff, the check passes regardless of what was added." That leaves the
 * likelier failure in a multi-round PR completely unwatched — a bullet that was
 * accurate when written and was invalidated by a **later commit in the same
 * PR**.
 *
 * It fired six times on one PR (#625), all in the same direction. Four
 * `/code-review` rounds corrected the code and the `.context/` docs; none went
 * back to the CHANGELOG, so bullets kept describing behaviour the branch had
 * since changed — "behaviour is otherwise identical to `setTimeout`" after a
 * post-unmount no-op was added, "capped at 4" after the cap became
 * `min(4, floor(cores / 2))`. Every one passed step 5d, because `CHANGELOG.md`
 * was in the diff. A sixth was introduced by the manual audit that found the
 * first five: a vague phrase replaced with a branch SHA that does not exist on
 * `main`, because the PR was squash-merged.
 *
 * **Why the CHANGELOG and not `.context/`.** A `.context/` doc is read by
 * someone already in the codebase, who can check a claim against the source in
 * seconds. The CHANGELOG is read by a fork maintainer deciding what an upgrade
 * will cost them, with no code in front of them. Sunrise has four live forks.
 *
 * Two rules, and they are different kinds of thing:
 *
 * 1. **{@link findDrift} is a heuristic.** It correlates the identifiers a
 *    bullet quotes in backticks against the commits that changed those strings
 *    later in the same branch. It will produce false positives — a bullet
 *    quoting `validate` will link to any later commit that touched the word.
 *    That is why this check is a **reminder that never gates**: an unanswerable
 *    gate is the defect #608 fixes one file over, and shipping one here while
 *    fixing one there would be absurd.
 * 2. **{@link unreachableCommits} is not.** A short SHA either is or is not
 *    reachable from `origin/main`, and one that is not will stop resolving the
 *    moment the branch is squash-merged. The caller does the reachability test;
 *    this module only finds the candidates.
 *
 * @see scripts/ci/check-changelog-drift.ts — the CLI that reads git
 * @see scripts/ci/changelog-structure.ts — the structural rules, which gate
 */

import { parseChangelog } from '@/scripts/ci/changelog-structure';

/** One top-level `- ` entry under `## [Unreleased]`, wrapped lines included. */
export interface ChangelogBullet {
  /** 1-indexed line of the `- `. */
  startLine: number;
  /** 1-indexed last line of the entry, blank trailing lines excluded. */
  endLine: number;
  /** The entry's full text, newlines and backticks intact. */
  text: string;
}

/** A commit on the branch, in `git rev-list --reverse` order. */
export interface BranchCommit {
  /** Position in the branch, ascending. Older commits sort lower. */
  index: number;
  sha: string;
  subject: string;
}

/** A bullet that may no longer describe what the branch ended up doing. */
export interface DriftFinding {
  bullet: ChangelogBullet;
  /** 1-indexed file line the identifier sits on — what gets reported. */
  line: number;
  /** The backticked identifier that links the bullet to later work. */
  token: string;
  /** The commits that changed `token` after that line was written. */
  commits: BranchCommit[];
  /**
   * True when the line predates the branch — an entry an earlier PR left in
   * `[Unreleased]`.
   *
   * Reported separately, because *every* branch commit counts as later for
   * these, and that makes them far noisier than a bullet this branch wrote.
   * Measured on the branch that introduced this check: 11 flagged bullets, all
   * 11 inherited, none of them stale. Kept rather than dropped because a PR
   * that invalidates someone else's pending entry is the same defect, and the
   * split costs nothing but a heading.
   */
  inherited: boolean;
}

/** How a bullet's `writtenAt` position is reported when it predates the branch. */
export const PREDATES_BRANCH = -1;

/** A fenced-code delimiter, per CommonMark's ≤3-space indent allowance. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

/** A top-level entry: `- ` hard against the left margin. */
const BULLET_RE = /^- +\S/;

/**
 * Every top-level bullet in the `## [Unreleased]` section.
 *
 * Nested bullets and wrapped lines are absorbed into the entry that owns them,
 * because the unit a reader judges is the entry, not the line. Bullets inside a
 * fenced code block are skipped — a changelog entry quoting a shell session is
 * sample text, not a claim.
 *
 * Returns `[]` when there is no `[Unreleased]` section, which is a legitimate
 * state right after a release is cut.
 */
export function extractUnreleasedBullets(source: string): ChangelogBullet[] {
  const parsed = parseChangelog(source);
  const start = parsed.unreleased[0];
  if (start === undefined) return [];

  // The section ends at the next `## ` of any kind. Taking it from the parser
  // rather than re-scanning means fences and HTML comments are already handled
  // by the code that gates on them, so the two cannot disagree about where a
  // section ends.
  const laterHeadings = [
    ...parsed.unreleased.filter((line) => line > start),
    ...parsed.releases.map((release) => release.line).filter((line) => line > start),
    ...parsed.violations.map((violation) => violation.line).filter((line) => line > start),
  ];
  const end = laterHeadings.length > 0 ? Math.min(...laterHeadings) : Number.POSITIVE_INFINITY;

  const lines = source.split('\n');
  const bullets: ChangelogBullet[] = [];
  let current: { startLine: number; lines: string[] } | null = null;
  let fence: string | null = null;

  const close = () => {
    if (current === null) return;
    // Trailing blanks belong to the gap between entries, not to the entry.
    while (current.lines.length > 0 && current.lines[current.lines.length - 1].trim() === '') {
      current.lines.pop();
    }
    if (current.lines.length > 0) {
      bullets.push({
        startLine: current.startLine,
        endLine: current.startLine + current.lines.length - 1,
        text: current.lines.join('\n'),
      });
    }
    current = null;
  };

  for (let index = start; index < Math.min(lines.length, end - 1); index += 1) {
    const text = lines[index];
    const line = index + 1;

    const fenceMatch = FENCE_RE.exec(text);
    if (fenceMatch) {
      // Only a delimiter of the same character closes the block, matching
      // CommonMark and the structural parser next door.
      if (fence === null) {
        close();
        fence = fenceMatch[1][0];
      } else if (fenceMatch[1][0] === fence) {
        fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    if (BULLET_RE.test(text)) {
      close();
      current = { startLine: line, lines: [text] };
      continue;
    }

    if (current === null) continue;

    // A line at the left margin that is not a bullet ends the entry; anything
    // indented, or blank, is still part of it.
    if (text.trim() !== '' && !/^\s/.test(text)) close();
    else current.lines.push(text);
  }
  close();

  return bullets;
}

/**
 * The backticked identifiers a bullet quotes, deduplicated in first-seen order.
 *
 * Backticks are the whole signal: prose is unsearchable, and an author who
 * quoted `CI_NODE_HEAP_MB` has named the thing the claim depends on. A trailing
 * `()` is stripped — code contains `useTimeout(` with arguments, so searching
 * for the literal `useTimeout()` would match nothing.
 *
 * Spans shorter than {@link MIN_IDENTIFIER} are dropped. A one- or two-
 * character token (`4`, `ms`) occurs in almost every commit, so it carries no
 * information about *this* bullet while costing a git invocation to find out.
 *
 * **A span of nothing but lowercase letters is dropped too**, which is the
 * single change that made this check readable. Measured against this repo's own
 * `[Unreleased]` section on a two-commit branch, the flags were `null`, `false`,
 * `undefined`, `string`, `app`, `build`, `run`, `validate` and `lockfile` — nine
 * of thirteen, every one a word that occurs in hundreds of files and locates
 * nothing. Anything with an uppercase letter, a digit or punctuation is a name:
 * `setTimeout`, `CI_NODE_HEAP_MB`, `tests/setup.ts`, `node:http`, `cores - 1`.
 * All sixteen identifiers this check finds on #625 survive the rule.
 *
 * The cost is a lowercase package name — `hono`, `epub` — which would have
 * located something. `epub2` survives on its digit; `hono` does not. Taken
 * knowingly: a bullet naming a package almost always names a file or a symbol
 * too, and a reminder people scroll past is worth nothing.
 */
export const MIN_IDENTIFIER = 3;

/** Lowercase-only spans are prose, not names. See {@link identifiersIn}. */
const PROSE_WORD = /^[a-z]+$/;

export function identifiersIn(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // Double-backtick spans exist to quote a literal backtick; the single-tick
  // form is what this changelog uses, and matching greedily across a line
  // would swallow the prose between two separate spans.
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim().replace(/\(\)$/, '').trim();
    if (token.length < MIN_IDENTIFIER || PROSE_WORD.test(token) || seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

/**
 * Hex-ish tokens that might be commit SHAs, for the caller to resolve.
 *
 * Requires **both** a digit and a letter, which is what separates `d23d458`
 * from `defaced` and `effaced` — English words that happen to be pure hex. It
 * is deliberately generous otherwise: the caller resolves each against git and
 * silently drops anything that is not a commit, so a false candidate here costs
 * one `rev-parse` and never reaches a human.
 */
export function shaCandidatesIn(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) {
    const token = match[0];
    if (!/\d/.test(token) || !/[a-f]/.test(token) || seen.has(token)) continue;
    seen.add(token);
    found.push(token);
  }
  return found;
}

/**
 * Bullets whose quoted identifiers were changed by a later commit.
 *
 * Pure: the caller supplies which commit last wrote each **line** (`writtenAt`,
 * keyed on file line number) and which commits touched each identifier
 * (`touchedBy`). A line that predates the branch entirely is passed as
 * {@link PREDATES_BRANCH}, so every branch commit counts as later — a
 * pre-existing `[Unreleased]` entry this branch invalidated is the same defect,
 * arriving by a different route.
 *
 * **Per line, not per bullet**, and that is not a detail. Taking a bullet's
 * newest blame hides every claim in it that was written earlier: on #625 the
 * CI-heap bullet had round 4 rewrite its last five lines, which made the whole
 * entry look freshly written and masked a `cores - 1` claim from round 1 that
 * round 3 had invalidated. Measured on that branch: per bullet, 7 findings
 * across 3 of the 4 bullets; per line, 16 across all 4. The issue counted 6
 * genuinely stale claims, so the extra flags are the false-positive cost being
 * paid up front — which is why the report groups by bullet and why nothing
 * here gates.
 *
 * One finding per (bullet, identifier) rather than per bullet: the identifier
 * is what makes the flag checkable, and collapsing them would leave a reader
 * with "this bullet might be stale" and nowhere to start.
 */
export function findDrift(
  bullets: readonly ChangelogBullet[],
  writtenAt: ReadonlyMap<number, number>,
  touchedBy: ReadonlyMap<string, readonly BranchCommit[]>
): DriftFinding[] {
  const findings: DriftFinding[] = [];

  for (const bullet of bullets) {
    const lines = bullet.text.split('\n');
    const reported = new Set<string>();

    for (let offset = 0; offset < lines.length; offset += 1) {
      const line = bullet.startLine + offset;
      const written = writtenAt.get(line);
      // A line with no recorded position was not read from git at all; saying
      // nothing about it is the only honest option, and it is the caller's job
      // to report that it could not be blamed.
      if (written === undefined) continue;

      for (const token of identifiersIn(lines[offset])) {
        if (reported.has(token)) continue;
        const later = (touchedBy.get(token) ?? []).filter((commit) => commit.index > written);
        if (later.length === 0) continue;
        reported.add(token);
        findings.push({
          bullet,
          line,
          token,
          commits: later,
          inherited: written === PREDATES_BRANCH,
        });
      }
    }
  }

  return findings;
}

/** The first line of a bullet, trimmed for a one-line report. */
export function summarise(bullet: ChangelogBullet, width = 72): string {
  const first = bullet.text.split('\n')[0].replace(/^- +/, '').trim();
  return first.length <= width ? first : `${first.slice(0, width - 1)}…`;
}
