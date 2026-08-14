/**
 * `npm audit` triage rules — pure, no IO.
 *
 * ## Why a scheduled audit exists at all
 *
 * `dependency-review` runs on `pull_request` and compares base against head,
 * so it gates what a PR *adds*. Once a vulnerable version is on `main` no later
 * PR introduces it and the check stays green forever. That is the action
 * working as designed, not a misconfiguration — it simply cannot answer "is the
 * tree clean right now?".
 *
 * Dependabot *can* answer that, and on this repo it does: alerts are open and
 * PRs get raised. The narrow thing neither covers is an advisory whose remedy
 * lives in a **grandparent**. `ws@8.20.1` (#538) was held there by
 * `engine.io` and `socket.io-adapter`, both declaring `ws: ~8.20.1` and neither
 * vulnerable themselves, so the security updater had no package to bump and the
 * alert sat open for seven weeks. `adm-zip` is in that state today: a fix
 * exists at 0.6.0 and `epub2` pins it out of reach.
 *
 * The larger reason is **forks**. A fork inherits this workflow file for free.
 * It does not inherit anyone watching a Security tab, and private forks must
 * enable alerts explicitly. `npm audit` needs no Advanced Security, so unlike
 * CodeQL and dependency-review this runs everywhere.
 *
 * ## What gates, and why not everything
 *
 * Only **actionable** findings fail the job: at or above the floor *and* npm
 * reports a non-major fix. Everything else is reported.
 *
 * That is measured, not squeamish. Of 12 advisories on `main` when this was
 * written, two high ones had no fix at all (`adm-zip`, `epub2`). A plain
 * `npm audit --audit-level=high` would have failed on day one and every week
 * after, for something nobody could clear — and a job that is always red is a
 * job people stop reading. Gating on fixability is self-clearing instead: the
 * day `epub2` accepts a patched `adm-zip`, the finding becomes actionable and
 * the job goes red on its own. No allowlist file to curate, no expiry dates to
 * forget, nothing for a fork to inherit and misconfigure.
 *
 * ### The case this does NOT cover
 *
 * Self-clearing answers "no fix published". It does **not** answer "a fix
 * exists, we assessed it, and we cannot take it" — a bump that breaks a
 * feature, say. That finding is `blocking` by definition and stays red every
 * week, which is the exact failure this design was meant to avoid. The
 * argument above only ever covered half the space; saying so here so the next
 * reader does not conclude otherwise.
 *
 * The first answer is usually **not** a suppression. For the grandparent-pin
 * shape this job exists for, a `package.json` `overrides` entry forces the
 * patched transitive past the parent's declared range and clears the finding
 * *legitimately*, because the tree actually changes. It is not a back door
 * either: `hasRisk` in `lockfile-diff.ts` gates on any `overrides` change, so
 * it lands as a reviewed decision. It can break the parent that declared the
 * range, which is precisely why it is gated rather than quiet.
 *
 * If overriding genuinely breaks things, there is no good option today —
 * `--report` drops gating entirely and `--floor` drops a whole severity. The
 * trigger for building something better is the **first consciously declined
 * fixable finding**, and the shape should be a suppression keyed on advisory
 * id + package + version + reason + **expiry**. The expiry is what answers the
 * objection above: an entry that lapses forces re-examination instead of
 * rotting, and the version key stops it applying once the dependency moves.
 * Not built pre-emptively, because a file every fork inherits and must curate
 * should not exist before the situation it serves.
 *
 * A fix needing a **major** bump is reported separately rather than gated. It
 * is actionable in principle, but a cron job cannot decide that a fork should
 * take a breaking upgrade this week.
 *
 * ## What this deliberately does not do
 *
 * `--omit=dev` is not used. The issue proposed it to "keep the signal
 * actionable"; measured against the real tree it removes exactly two findings,
 * `@react-email/ui` and `js-yaml`, **both fixable**, while leaving both
 * unfixable ones in place. It strips actionable signal and keeps the noise. A
 * compromised dev dependency still runs on developer machines and in CI.
 *
 * @see scripts/ci/check-audit.ts — the CLI that runs npm and prints
 * @see .github/workflows/dependency-audit.yml
 */

/** npm's severity ladder, lowest first. */
export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITIES)[number];

/** Whether `severity` is at or above `floor` on npm's ladder. */
export function atLeast(severity: Severity, floor: Severity): boolean {
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(floor);
}

/** What npm says can be done about an advisory. */
export type FixKind =
  /** A patched version is reachable without a breaking upgrade. */
  | 'available'
  /** Reachable, but only by taking a major bump of some dependency. */
  | 'major'
  /** Nothing to install — usually a parent pinning the fix out of reach. */
  | 'none';

/** One vulnerable package, flattened out of npm's report. */
export interface Advisory {
  name: string;
  severity: Severity;
  /** Named in `package.json`, as opposed to pulled in by something else. */
  direct: boolean;
  fix: FixKind;
  /** `name@version` npm would move to, when it says so. */
  fixTarget: string | null;
  /** Advisory titles, deduped — `via` repeats them across paths. */
  titles: string[];
  /**
   * Packages this one is vulnerable *through*, when npm names no advisory.
   *
   * `via` holds advisory objects for a directly-vulnerable package and bare
   * package names for one that inherits the problem. Without this, those rows
   * render with an empty Advisory column — measured on the real tree, that was
   * two of the eight high findings (`@react-email/ui` via `next`, `epub2` via
   * `adm-zip`), i.e. a quarter of the rows a maintainer reads said nothing.
   */
  via: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asSeverity(value: unknown): Severity | null {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value)
    ? (value as Severity)
    : null;
}

/** Reads `fixAvailable`, which npm writes as `true`, `false`, or an object. */
export function readFix(value: unknown): { fix: FixKind; fixTarget: string | null } {
  if (value === true) return { fix: 'available', fixTarget: null };
  if (!isRecord(value)) return { fix: 'none', fixTarget: null };

  const name = typeof value.name === 'string' ? value.name : null;
  const version = typeof value.version === 'string' ? value.version : null;
  return {
    fix: value.isSemVerMajor === true ? 'major' : 'available',
    fixTarget: name !== null && version !== null ? `${name}@${version}` : name,
  };
}

/**
 * Splits a `via` array, which mixes advisory objects with bare package names.
 *
 * Both halves are kept: the objects carry the advisory title, and the strings
 * name the package this one is vulnerable through — the only thing there is to
 * say about a row that has no advisory of its own.
 */
function readVia(via: unknown): { titles: string[]; names: string[] } {
  if (!Array.isArray(via)) return { titles: [], names: [] };
  const titles = via
    .filter(isRecord)
    .map((entry) => entry.title)
    .filter((title): title is string => typeof title === 'string' && title !== '');
  const names = via.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
  return { titles: [...new Set(titles)], names: [...new Set(names)] };
}

/**
 * Flattens `npm audit --json` into a sorted list.
 *
 * Tolerant by construction: this parses the output of whatever npm the runner
 * has, and a shape change should degrade to "nothing found" for that entry
 * rather than throw halfway through a security check. An entry missing a
 * recognisable severity is skipped — {@link auditIsUsable} is what catches a
 * report this could not read at all.
 */
export function parseAuditReport(raw: unknown): Advisory[] {
  if (!isRecord(raw) || !isRecord(raw.vulnerabilities)) return [];

  const out: Advisory[] = [];
  for (const [key, value] of Object.entries(raw.vulnerabilities)) {
    if (!isRecord(value)) continue;
    const severity = asSeverity(value.severity);
    if (severity === null) continue;

    const { fix, fixTarget } = readFix(value.fixAvailable);
    const { titles, names } = readVia(value.via);
    out.push({
      name: typeof value.name === 'string' && value.name !== '' ? value.name : key,
      severity,
      direct: value.isDirect === true,
      fix,
      fixTarget,
      titles,
      via: names,
    });
  }

  return out.sort(
    (a, b) =>
      SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) ||
      a.name.localeCompare(b.name)
  );
}

/**
 * Whether the report is one we actually understood.
 *
 * An empty `vulnerabilities` map is a real, common answer ("clean tree"), and
 * is indistinguishable from a parse that silently fell through — so the shape
 * is checked rather than the count. Without this, `npm audit` changing its
 * output format would read as a permanent all-clear, which is the worst
 * possible failure for a security check: green, and blind.
 */
export function auditIsUsable(raw: unknown): boolean {
  return isRecord(raw) && isRecord(raw.vulnerabilities) && raw.auditReportVersion === 2;
}

/**
 * npm's own failure message, when the report is an error rather than a result.
 *
 * A registry failure comes back as well-formed JSON — `{"error": {"code":
 * "ENETUNREACH", "summary": "..."}}` — which parses cleanly and then fails
 * {@link auditIsUsable}. Without telling the two apart, an operator whose
 * network was down was informed that npm had changed its output format.
 */
export function auditError(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.error)) return null;
  const parts = [raw.error.code, raw.error.summary, raw.error.detail].filter(
    (part): part is string => typeof part === 'string' && part !== ''
  );
  return parts.length > 0 ? parts.join(' — ') : 'npm reported an error with no detail';
}

/** The buckets the job reports on and decides by. */
export interface Triage {
  /** At or above the floor with a non-major fix — these fail the job. */
  blocking: Advisory[];
  /** At or above the floor, fixable only by a major bump. Reported. */
  needsMajor: Advisory[];
  /** At or above the floor with no fix published. Reported. */
  unfixable: Advisory[];
  /** Below the floor, whatever their fix state. Reported. */
  belowFloor: Advisory[];
}

/** Sorts advisories into the buckets, given a severity floor. */
export function triage(advisories: Advisory[], floor: Severity = 'high'): Triage {
  const result: Triage = { blocking: [], needsMajor: [], unfixable: [], belowFloor: [] };
  for (const advisory of advisories) {
    if (!atLeast(advisory.severity, floor)) result.belowFloor.push(advisory);
    else if (advisory.fix === 'available') result.blocking.push(advisory);
    else if (advisory.fix === 'major') result.needsMajor.push(advisory);
    else result.unfixable.push(advisory);
  }
  return result;
}

/** A one-line count per bucket, for the console. */
export function summarise(result: Triage, floor: Severity): string {
  return (
    `${result.blocking.length} fixable at ${floor}+, ` +
    `${result.needsMajor.length} needing a major bump, ` +
    `${result.unfixable.length} with no fix, ` +
    `${result.belowFloor.length} below ${floor}.`
  );
}

/**
 * Neutralises the two characters that can restructure a markdown table.
 *
 * Advisory titles come from the GitHub Advisory Database, so they are prose
 * written by a third party. A `|` splits a row into extra cells and a newline
 * ends the table outright, which would let a crafted advisory render arbitrary
 * text — a plausible-looking "no advisories found" line, say — into a summary
 * a maintainer reads as this job's output. The exit code and console output
 * are the authoritative signals and neither is affected, so this is belt and
 * braces; it is cheap, and a report that can be made to lie about itself is
 * precisely what this job exists to avoid.
 */
function cell(text: string): string {
  return text.replace(/[|\r\n]/g, ' ').trim();
}

function table(advisories: Advisory[]): string[] {
  if (advisories.length === 0) return ['_None._', ''];
  return [
    '| Package | Severity | Depth | Fix | Advisory |',
    '| --- | --- | --- | --- | --- |',
    ...advisories.map((a) => {
      const fix =
        a.fix === 'none'
          ? 'none published'
          : (a.fixTarget ?? (a.fix === 'major' ? 'major' : 'yes'));
      // Fall back to what it is vulnerable *through*, so the cell is never
      // blank — and so the row says why fixing the named package clears it.
      const title =
        a.titles.length > 0
          ? cell(a.titles[0])
          : a.via.length > 0
            ? `via ${a.via.map(cell).join(', ')}`
            : '';
      const extra = a.titles.length > 1 ? ` (+${a.titles.length - 1} more)` : '';
      return `| \`${cell(a.name)}\` | ${a.severity} | ${a.direct ? 'direct' : 'transitive'} | ${cell(fix)} | ${title}${extra} |`;
    }),
    '',
  ];
}

/**
 * The GitHub step summary.
 *
 * Every bucket is rendered, including the ones that do not gate — the whole
 * point of reporting an unfixable advisory is that somebody can see it is
 * still there, and a job that gates on a subset must not imply the rest is
 * clean.
 */
export function formatSummary(result: Triage, floor: Severity): string {
  const lines = ['# Dependency audit', ''];

  lines.push(
    result.blocking.length > 0
      ? `**${result.blocking.length} fixable ${floor}+ ${result.blocking.length === 1 ? 'advisory' : 'advisories'}.** These fail the job — a patched version is reachable today.`
      : `**No fixable ${floor}+ advisories.**`,
    ''
  );

  lines.push(`## Fixable, ${floor}+ — actionable now`, '', ...table(result.blocking));
  lines.push(
    `## Fix needs a major bump, ${floor}+`,
    '',
    '_Reported, not gated: a scheduled job should not decide a breaking upgrade._',
    '',
    ...table(result.needsMajor)
  );
  lines.push(
    `## No fix published, ${floor}+`,
    '',
    '_Reported, not gated. Usually a parent pinning the fix out of reach — the' +
      ' shape Dependabot cannot act on. Becomes gating the moment a fix lands._',
    '',
    ...table(result.unfixable)
  );
  lines.push(`## Below ${floor}`, '', ...table(result.belowFloor));

  return lines.join('\n');
}
