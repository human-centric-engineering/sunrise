/**
 * CHANGELOG.md structure rules — pure, no IO.
 *
 * `CHANGELOG.md` is the one file a fork reads before deciding what an upgrade
 * will cost it, and the release process edits it by **text replacement** on
 * every single release (CONTRIBUTING "Cutting a release" step 4). That is a
 * failure mode available every time, and when it fires the damage is
 * misattributing migrations and breaking changes to the wrong version.
 *
 * It has already fired once. Cutting 0.8.1 replaced a block that included the
 * previous release's heading, `## [0.8.0]` was never re-added, and 962 lines of
 * 0.8.0 content — its release blockquote, two migrations, two breaking changes
 * — re-attributed themselves to a patch release. It merged and was tagged.
 * Nothing caught it: Prettier saw well-formed markdown, `/security-review`
 * correctly skips markdown, `/pre-pr` step 5d checks the CHANGELOG is *present*
 * in a public-surface diff and never looks at its structure, and CI had no
 * CHANGELOG job at all. What surfaced it was the release-notes extraction
 * throwing on a missing closing boundary — luck, not a control (#550).
 *
 * Two kinds of rule live here, and the split matters:
 *
 * - **Static** ({@link checkChangelogStructure}) — everything derivable from
 *   the file plus `SUNRISE_VERSION`. Cheap, runs in `npm run validate`.
 * - **Historical** ({@link checkReleaseHistoryPreserved}) — needs the previous
 *   revision of the file. This is the one that catches the incident above: a
 *   *deletion* leaves a perfectly well-formed file behind, so no amount of
 *   static checking can see it. The four rules sketched in #550 are all static
 *   and, checked against the merged commit (`c968e131`), none of them fails on
 *   it — the headings that remained were unique, correctly dated, in
 *   descending order, and `SUNRISE_VERSION` matched the topmost.
 *
 * @see scripts/ci/check-changelog.ts — the CLI that reads the files
 * @see CONTRIBUTING.md — "Cutting a release"
 */

/** A single structural problem, ready to print as `CHANGELOG.md:<line>`. */
export interface ChangelogViolation {
  /** 1-indexed line number, or 0 for a finding about the file as a whole. */
  line: number;
  message: string;
}

/**
 * The result of the append-only comparison.
 *
 * `skipped` is not a softer kind of pass. It says the comparison was not made,
 * and it exists because the alternative — returning `[]` — is indistinguishable
 * from "checked, nothing deleted", which is the precise failure this whole file
 * exists to prevent. Callers are expected to surface it.
 */
export interface HistoryCheck {
  violations: ChangelogViolation[];
  skipped: 'head-truncated' | 'base-truncated' | null;
}

/** A well-formed `## [x.y.z] — YYYY-MM-DD` heading. */
export interface ReleaseHeading {
  line: number;
  version: string;
  date: string;
}

/** A `### <Category>` heading and the `## ` section it falls under. */
export interface CategoryHeading {
  line: number;
  label: string;
  /** Line of the enclosing `## ` heading; 0 if it precedes every section. */
  sectionLine: number;
}

/** The outcome of reading every heading in the file. */
export interface ParsedChangelog {
  /** Line number of each `## [Unreleased]` heading, in file order. */
  unreleased: number[];
  /** Every well-formed release heading, in file order. */
  releases: ReleaseHeading[];
  /** Every `### ` heading, in file order. */
  categories: CategoryHeading[];
  /** Headings that are not one of the two recognized shapes. */
  violations: ChangelogViolation[];
  /**
   * Where reading stopped early, and what stopped it — or `null`.
   *
   * When this is set the heading lists above are **truncated**: everything
   * below that line went unread, so any rule that reasons across headings
   * (uniqueness, ordering, `SUNRISE_VERSION` agreement, the history
   * comparison) would be drawing conclusions from a partial file. Callers must
   * check it before trusting those lists.
   */
  truncation: { line: number; kind: 'fence' | 'comment' } | null;
}

/**
 * The Keep a Changelog 1.1.0 category set, which CLAUDE.md requires entries to
 * use. A near-miss (`### Fixes`, `### Security Fixes`) still renders fine and
 * still reads fine in isolation — it just drops out of the scan a fork does
 * when it wants to know, across ten releases, what broke and what moved.
 */
const CATEGORIES = ['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'];

/**
 * The canonical heading shapes, quoted in error messages so a contributor who
 * has never read this file can fix the problem from the failure alone.
 */
const SHAPE_HINT = '`## [Unreleased]` or `## [x.y.z] — YYYY-MM-DD`';

/**
 * `## anything` — level 2 exactly; `### ` is matched separately below.
 *
 * Leading spaces are allowed to the same depth as a fence, because Markdown
 * allows them: a heading indented one to three spaces still renders as a
 * heading, and one this parser could not see would be reported as *deleted*
 * rather than as indented — a true failure with a message naming the wrong
 * cause.
 */
const HEADING_RE = /^ {0,3}## +(.*?)\s*$/;

/** `### anything` — level 3 exactly, so `####` and deeper are left alone. */
const CATEGORY_RE = /^ {0,3}### +(.*?)\s*$/;

/** `[label]rest` — the bracketed label plus whatever trails it. */
const LABELLED_RE = /^\[([^\]]*)\](.*)$/;

/**
 * The date suffix. The separator is deliberately lenient — Sunrise writes an em
 * dash, Keep a Changelog's own examples use a hyphen, and a fork that picks
 * either is not making the mistake this file exists to catch. The date itself
 * is not lenient.
 *
 * The optional trailing `[YANKED]` is Keep a Changelog 1.1.0's own marker for a
 * pulled release. Nothing here reads it, but rejecting it would mean this file
 * blocks the one edit it most exists to support: recording that a release went
 * out wrong. We enforce the spec's category set, so we accept the spec's
 * heading forms.
 */
const DATE_SUFFIX_RE = /^\s*[—–-]\s*(.+?)(?:\s+\[YANKED\])?\s*$/;

/** `x.y.z`, numeric only. No prerelease suffixes — Sunrise has never cut one. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * A fenced-code-block delimiter (CommonMark: indented ≤3 spaces). Captures the
 * full run of markers and whatever trails it, because both matter when deciding
 * whether a delimiter *closes* the open block — see {@link parseChangelog}.
 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-trip rather than a NaN check alone: it is the only way to reject a
  // syntactically fine but nonexistent date such as 2026-02-30.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Compares two strings already validated against {@link VERSION_RE}. */
function compareVersions(a: string, b: string): number {
  const left = a.split('.');
  const right = b.split('.');
  for (let i = 0; i < 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Read every level-2 heading, classifying each as `Unreleased`, a release, or a
 * violation.
 *
 * Headings inside fenced code blocks are skipped. That is not hypothetical
 * tidiness: CONTRIBUTING's release instructions contain the literal string
 * `## [X.Y.Z] — YYYY-MM-DD`, and quoting them into a changelog entry would
 * otherwise register as a heading with an unparseable version.
 */
export function parseChangelog(source: string): ParsedChangelog {
  const unreleased: number[] = [];
  const releases: ReleaseHeading[] = [];
  const categories: CategoryHeading[] = [];
  const violations: ChangelogViolation[] = [];

  /** The opening delimiter of the fenced block we are inside, or null. */
  let fence: string | null = null;
  let fenceLine = 0;
  /** Opening line of the HTML comment we are inside, or 0. */
  let commentLine = 0;
  let sectionLine = 0;

  // A plain loop, not `forEach`: the skip state is mutated on almost every
  // iteration and read again after the loop, and a closure defeats the
  // control-flow narrowing that read depends on.
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    const line = index + 1;

    // Whichever construct opened first stays in charge until it closes. A
    // `<!--` inside a code block is sample text; a ``` inside a comment is
    // commented out. Checking either unconditionally would let one end the
    // other.
    if (fence !== null) {
      const closing = FENCE_RE.exec(text);
      // CommonMark closes a block only on the same character, at least as long
      // as the opening run, and with no info string. Comparing the character
      // alone would let an inner ``` close an outer ````, which is precisely
      // how one code block gets nested inside another — and the headings in
      // between would then be read as real.
      if (
        closing &&
        closing[1][0] === fence[0] &&
        closing[1].length >= fence.length &&
        closing[2].trim() === ''
      ) {
        fence = null;
      }
      continue;
    }

    if (commentLine > 0) {
      // Content after `-->` on the closing line is skipped too. A heading
      // sharing a line with the end of a comment is not a thing anyone writes,
      // and guessing at it would cost more than it could ever return.
      if (text.includes('-->')) commentLine = 0;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(text);
    // A backtick fence may not carry backticks in its info string, so a line
    // like ```` ```npm run validate``` is now first ```` is a paragraph with
    // code spans, not an opening fence. Reading it as one swallowed the rest of
    // the file.
    if (fenceMatch && !(fenceMatch[1][0] === '`' && fenceMatch[2].includes('`'))) {
      fence = fenceMatch[1];
      fenceLine = line;
      continue;
    }

    if (text.includes('<!--') && !text.includes('-->')) {
      commentLine = line;
      continue;
    }

    const category = CATEGORY_RE.exec(text);
    if (category) {
      categories.push({ line, label: category[1], sectionLine });
      continue;
    }

    const heading = HEADING_RE.exec(text);
    if (!heading) continue;
    const content = heading[1];
    sectionLine = line;

    const labelled = LABELLED_RE.exec(content);
    if (!labelled) {
      violations.push({
        line,
        message: `Level-2 heading "${content}" is neither ${SHAPE_HINT}. Every \`## \` heading in this file is a version boundary; use \`### \` for sections within a release.`,
      });
      continue;
    }

    const [, label, rest] = labelled;

    if (label === 'Unreleased') {
      if (rest.trim() !== '') {
        violations.push({
          line,
          message: `\`## [Unreleased]\` must not carry a date — it is the section a release is cut *from*. Found "${content}".`,
        });
      }
      unreleased.push(line);
      continue;
    }

    if (!VERSION_RE.test(label)) {
      violations.push({
        line,
        message: `Heading label "[${label}]" is not a version. Expected ${SHAPE_HINT}.`,
      });
      continue;
    }

    const dateSuffix = DATE_SUFFIX_RE.exec(rest);
    if (!dateSuffix) {
      violations.push({
        line,
        message: `Release heading \`## [${label}]\` is missing its date. Expected \`## [${label}] — YYYY-MM-DD\`.`,
      });
      continue;
    }
    if (!isValidIsoDate(dateSuffix[1])) {
      violations.push({
        line,
        message: `Release heading \`## [${label}]\` has an invalid date "${dateSuffix[1]}". Expected \`YYYY-MM-DD\`.`,
      });
      continue;
    }

    releases.push({ line, version: label, date: dateSuffix[1] });
  }

  // An unclosed fence or comment swallows the rest of the file, and silence is
  // the worst possible response: every heading below it goes unread, and the
  // static rules would then report a clean file. Naming it is only half the job
  // — the truncated heading lists must not be reasoned over either, or the
  // output fills with confident nonsense about a file nobody finished reading.
  // That suppression lives in the two check functions below; `truncation` is
  // how they know.
  let truncation: ParsedChangelog['truncation'] = null;
  if (fence !== null) {
    truncation = { line: fenceLine, kind: 'fence' };
    violations.push({
      line: fenceLine,
      message: `Unclosed code fence — everything below line ${fenceLine} was skipped, so no heading after it was checked. Close it with a matching \`${fence}\`.`,
    });
  } else if (commentLine > 0) {
    truncation = { line: commentLine, kind: 'comment' };
    violations.push({
      line: commentLine,
      message: `Unclosed HTML comment — everything below line ${commentLine} was skipped, so no heading after it was checked. Close it with \`-->\`.`,
    });
  }

  return { unreleased, releases, categories, violations, truncation };
}

/**
 * The rules derivable from the file itself plus the platform version.
 *
 * Every violation is reported, not just the first — a release cut that got the
 * heading wrong usually got it wrong in more than one way, and a check that
 * makes you re-run it once per problem is a check people learn to route around.
 */
export function checkChangelogStructure(
  source: string,
  options: { sunriseVersion: string }
): ChangelogViolation[] {
  const parsed = parseChangelog(source);
  const violations = [...parsed.violations];

  // Everything below reasons across the full set of headings, and a truncated
  // parse means we do not have one. Reporting "no release headings found" or
  // "duplicate Unreleased" against a file we stopped reading a third of the way
  // in sends the author chasing the wrong defect. The per-heading violations
  // above are still sound — they were found before the fence — and the fence
  // violation among them says exactly what to fix.
  if (parsed.truncation) return violations;

  // ── `## [Unreleased]`: present, once, and before every release ──────────
  if (parsed.unreleased.length === 0) {
    violations.push({
      line: 0,
      message:
        'No `## [Unreleased]` heading. A release moves the entries out of it and leaves the heading in place, empty, for the next one (CONTRIBUTING "Cutting a release" step 4).',
    });
  }
  parsed.unreleased.slice(1).forEach((line) => {
    violations.push({
      line,
      message: `Duplicate \`## [Unreleased]\` heading (first is at line ${parsed.unreleased[0]}).`,
    });
  });

  const firstUnreleased = parsed.unreleased[0];
  if (firstUnreleased !== undefined) {
    parsed.releases
      .filter((release) => release.line < firstUnreleased)
      .forEach((release) => {
        violations.push({
          line: release.line,
          message: `\`## [${release.version}]\` appears above \`## [Unreleased]\` (line ${firstUnreleased}). Unreleased is always the first section.`,
        });
      });
  }

  // ── Each version exactly once ───────────────────────────────────────────
  const firstSeenAt = new Map<string, number>();
  parsed.releases.forEach((release) => {
    const seen = firstSeenAt.get(release.version);
    if (seen === undefined) {
      firstSeenAt.set(release.version, release.line);
      return;
    }
    violations.push({
      line: release.line,
      message: `Duplicate heading for ${release.version} (first is at line ${seen}). Two sections for one version means half its entries are invisible to anyone reading top-down.`,
    });
  });

  // ── Descending SemVer order ─────────────────────────────────────────────
  parsed.releases.forEach((release, index) => {
    const previous = parsed.releases[index - 1];
    if (!previous) return;
    // Strictly less-than, so equality belongs to the duplicate rule alone.
    // Firing both turned one bad edit into "2 structural problems".
    if (compareVersions(previous.version, release.version) < 0) {
      violations.push({
        line: release.line,
        message: `${release.version} is not below ${previous.version} in descending order (line ${previous.line}). Newest release first.`,
      });
    }
  });

  // ── Categories: canonical, and once per section ─────────────────────────
  const categorySeenAt = new Map<string, number>();
  parsed.categories.forEach((category) => {
    if (!CATEGORIES.includes(category.label)) {
      violations.push({
        line: category.line,
        message: `"### ${category.label}" is not a Keep a Changelog category. Use one of: ${CATEGORIES.join(', ')}.`,
      });
      return;
    }
    const key = `${category.sectionLine}/${category.label}`;
    const seen = categorySeenAt.get(key);
    if (seen === undefined) {
      categorySeenAt.set(key, category.line);
      return;
    }
    violations.push({
      line: category.line,
      message: `Second "### ${category.label}" in the same section (first is at line ${seen}). Append to the existing one — a split category means a reader scanning for what changed sees half of it.`,
    });
  });

  // ── SUNRISE_VERSION agrees with the topmost release ─────────────────────
  // Both directions matter. A bump with no entry leaves forks with a version
  // they cannot look up; an entry with no bump ships a release that reports
  // itself as the previous one. Same check either way.
  const latest = parsed.releases[0];
  if (!latest) {
    violations.push({
      line: 0,
      message: `No release headings found, but \`SUNRISE_VERSION\` is ${options.sunriseVersion}. Expected \`## [${options.sunriseVersion}] — YYYY-MM-DD\`.`,
    });
  } else if (latest.version !== options.sunriseVersion) {
    violations.push({
      line: latest.line,
      message: `Topmost release is ${latest.version} but \`SUNRISE_VERSION\` in lib/sunrise-version.ts is ${options.sunriseVersion}. Cutting a release bumps both in the same PR (CONTRIBUTING steps 2 and 4).`,
    });
  }

  return violations;
}

/**
 * Released history is append-only: a `## [x.y.z]` heading that exists on the
 * base revision must still exist here.
 *
 * This is the rule that catches #550's actual incident, and the only one that
 * can — a deleted heading leaves a file that is still valid in every static
 * sense. It was even visible in the reviewed diff, as a lone
 * `-## [0.8.0] — 2026-08-04` line, and got read past.
 *
 * Only *presence* is enforced, deliberately. Pinning the dates too would block
 * the occasional legitimate correction with no escape hatch, and a wrong date
 * is a smaller harm than a section of entries silently changing which release
 * it belongs to. Malformed dates are still caught statically.
 *
 * Violations in the base revision are ignored: the base may predate this check,
 * and a contributor cannot fix history from their branch anyway.
 *
 * Either side may be **untrustworthy** rather than merely wrong, though, and
 * the comparison is then not made at all — see {@link HistoryCheck.skipped}.
 * "Absent from the parsed list" and "absent from the file" are the same value
 * here, so a truncated parse turns this rule into a liar in one direction and a
 * no-op in the other.
 */
export function checkReleaseHistoryPreserved(baseSource: string, headSource: string): HistoryCheck {
  const head = parseChangelog(headSource);
  // Head truncated: every swallowed release looks deleted. Reporting that would
  // tell the author to re-add headings that are sitting right there, and bury
  // the one message that names the real defect. The static rules already
  // surfaced the unclosed fence or comment.
  if (head.truncation) return { violations: [], skipped: 'head-truncated' };

  const base = parseChangelog(baseSource);
  // Base truncated: the opposite failure, and the worse one — releases we never
  // read cannot be missed, so a genuine deletion passes. Say so rather than
  // report a clean comparison. Not a violation: the damage is on a revision the
  // contributor did not write and cannot fix from their branch.
  if (base.truncation) return { violations: [], skipped: 'base-truncated' };

  const present = new Set(head.releases.map((release) => release.version));

  return {
    violations: base.releases
      .filter((release) => !present.has(release.version))
      .map((release) => ({
        line: 0,
        message: `Released heading \`## [${release.version}] — ${release.date}\` was deleted (it was at line ${release.line} on the base revision). Its entries now read as part of whichever release precedes them. Re-add the heading; anchor a new release entry on \`## [Unreleased]\` alone, never on a block that includes the previous release's heading.`,
      })),
    skipped: null,
  };
}
