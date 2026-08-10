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

/** `## anything` — level 2 exactly; `### ` is matched separately below. */
const HEADING_RE = /^## +(.*?)\s*$/;

/** `### anything` — level 3 exactly, so `####` and deeper are left alone. */
const CATEGORY_RE = /^### +(.*?)\s*$/;

/** `[label]rest` — the bracketed label plus whatever trails it. */
const LABELLED_RE = /^\[([^\]]*)\](.*)$/;

/**
 * The date suffix. The separator is deliberately lenient — Sunrise writes an em
 * dash, Keep a Changelog's own examples use a hyphen, and a fork that picks
 * either is not making the mistake this file exists to catch. The date itself
 * is not lenient.
 */
const DATE_SUFFIX_RE = /^\s*[—–-]\s*(.+?)\s*$/;

/** `x.y.z`, numeric only. No prerelease suffixes — Sunrise has never cut one. */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Opening or closing fence of a fenced code block (CommonMark: ≤3 spaces). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

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

  let fence: string | null = null;
  let sectionLine = 0;

  source.split('\n').forEach((text, index) => {
    const line = index + 1;

    const fenceMatch = FENCE_RE.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fence === null) {
        fence = marker[0];
      } else if (marker[0] === fence) {
        fence = null;
      }
      return;
    }
    if (fence !== null) return;

    const category = CATEGORY_RE.exec(text);
    if (category) {
      categories.push({ line, label: category[1], sectionLine });
      return;
    }

    const heading = HEADING_RE.exec(text);
    if (!heading) return;
    const content = heading[1];
    sectionLine = line;

    const labelled = LABELLED_RE.exec(content);
    if (!labelled) {
      violations.push({
        line,
        message: `Level-2 heading "${content}" is neither ${SHAPE_HINT}. Every \`## \` heading in this file is a version boundary; use \`### \` for sections within a release.`,
      });
      return;
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
      return;
    }

    if (!VERSION_RE.test(label)) {
      violations.push({
        line,
        message: `Heading label "[${label}]" is not a version. Expected ${SHAPE_HINT}.`,
      });
      return;
    }

    const dateSuffix = DATE_SUFFIX_RE.exec(rest);
    if (!dateSuffix) {
      violations.push({
        line,
        message: `Release heading \`## [${label}]\` is missing its date. Expected \`## [${label}] — YYYY-MM-DD\`.`,
      });
      return;
    }
    if (!isValidIsoDate(dateSuffix[1])) {
      violations.push({
        line,
        message: `Release heading \`## [${label}]\` has an invalid date "${dateSuffix[1]}". Expected \`YYYY-MM-DD\`.`,
      });
      return;
    }

    releases.push({ line, version: label, date: dateSuffix[1] });
  });

  return { unreleased, releases, categories, violations };
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
    if (compareVersions(previous.version, release.version) <= 0) {
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
 */
export function checkReleaseHistoryPreserved(
  baseSource: string,
  headSource: string
): ChangelogViolation[] {
  const base = parseChangelog(baseSource);
  const head = parseChangelog(headSource);
  const present = new Set(head.releases.map((release) => release.version));

  return base.releases
    .filter((release) => !present.has(release.version))
    .map((release) => ({
      line: 0,
      message: `Released heading \`## [${release.version}] — ${release.date}\` was deleted (it was at line ${release.line} on the base revision). Its entries now read as part of whichever release precedes them. Re-add the heading; anchor a new release entry on \`## [Unreleased]\` alone, never on a block that includes the previous release's heading.`,
    }));
}
