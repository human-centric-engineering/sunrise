/**
 * Node major-version consistency — rules.
 *
 * WHY THIS EXISTS: the Node major is stated in five places that no tool
 * reconciles — `.nvmrc` (what CI installs), `Dockerfile` and `Dockerfile.dev`
 * (what ships), `engines.node` (what forks are told), and the `@types/node`
 * devDependency (what `tsc` believes). #581 collapsed eight hardcoded CI pins
 * (six in `ci.yml`, two in `dependency-audit.yml`) down to `.nvmrc`, but the
 * remaining five are structurally unavoidable: a `FROM` line cannot read
 * `.nvmrc`, and npm cannot read a Dockerfile.
 *
 * The failure that motivates this is silent and asymmetric. Bump `.nvmrc`
 * alone and every CI job goes green on the new major while the image that
 * actually serves traffic still builds the old one — the tests pass *because*
 * they are no longer testing what ships. That is the same shape as the drift
 * this check's own PR set out to remove, so leaving it unguarded would have
 * been the change congratulating itself.
 *
 * `@types/node` was excluded when this check first landed, and disagreed —
 * `^26` against a `>=24` runtime, so `tsc` accepted APIs that throw in the
 * production image, with the first signal a `TypeError` on a path the types
 * called safe. It is now the fifth source (#584). Pinning it to `^24` produced
 * a clean `tsc --noEmit`, so nothing depended on the post-24 surface.
 *
 * NOT checked: anything about the types package beyond its MAJOR. The minor is
 * free to move — `@types/node@24.x` tracks Node 24's own additions, which is
 * exactly what should happen. Dependabot carries an `ignore` for `>=25` so the
 * major cannot re-land silently; without it this check would simply start
 * failing on a Monday, which is a worse way to learn the same thing.
 *
 * Parsers take file *contents*, not paths, so the rules stay testable without
 * touching the repo's real files.
 */

/** One place the Node major is declared. `major: null` means "could not parse". */
export type NodeVersionSource = {
  /** Human-readable origin, used verbatim in failure messages. */
  label: string;
  major: number | null;
  /** The text the major was read from, for a message that shows the evidence. */
  raw: string;
};

/** `.nvmrc` — a bare version line, optionally `v`-prefixed. */
export function parseNvmrc(text: string): number | null {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  const match = /^v?(\d+)(?:\.\d+)*$/.exec(line);
  return match ? Number(match[1]) : null;
}

/**
 * `FROM node:<major>...` — the first such line wins.
 *
 * Deliberately not anchored to `-alpine`: a fork that switches to
 * `node:24-bookworm` still needs the major checked, and silently skipping it
 * would be worse than a parse failure.
 */
export function parseDockerfileMajor(text: string): number | null {
  for (const line of text.split('\n')) {
    const match = /^\s*FROM\s+node:(\d+)/i.exec(line);
    if (match) return Number(match[1]);
  }
  return null;
}

/** `engines.node` — reads the floor out of a `>=X` style range. */
export function parseEnginesMajor(engines: string | undefined): number | null {
  if (!engines) return null;
  const match = /(\d+)/.exec(engines);
  return match ? Number(match[1]) : null;
}

/**
 * The `@types/node` major `tsc` actually type-checks against.
 *
 * Takes `package-lock.json`'s text and reads the RESOLVED version at
 * `packages["node_modules/@types/node"].version` — not the range in
 * `package.json`.
 *
 * That distinction is the whole point, and an earlier version of this function
 * got it wrong by parsing the range. A range is a declaration of intent; the
 * resolved version is the fact, and it is what ends up on disk for `tsc` to
 * load. Several ranges npm accepts do not pin a major at all:
 *
 * | range      | parsed as | npm resolves |
 * | ---------- | --------- | ------------ |
 * | `^24.13.3` | 24        | 24.13.3      |
 * | `>=24`     | **24**    | **26.2.0**   |
 * | `>24`      | **24**    | **26.2.0**   |
 *
 * So `>=24` sailed through a check whose entire purpose is to catch `tsc`
 * running two majors ahead of the runtime, and `>24` parsed as the one major it
 * excludes. Reading the lockfile removes range interpretation from the problem
 * rather than trying to enumerate the safe forms.
 *
 * Returns `null` — a hard failure, not a skip — when the lockfile is missing,
 * unparseable, or has no entry. The package is a devDependency of this repo and
 * of every fork; its absence means something is wrong, not that there is
 * nothing to check.
 */
export function parseTypesNodeMajor(lockfileText: string | undefined): number | null {
  if (!lockfileText) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockfileText);
  } catch {
    return null;
  }
  const packages = (parsed as { packages?: Record<string, { version?: string }> }).packages;
  const version = packages?.['node_modules/@types/node']?.version;
  if (typeof version !== 'string') return null;
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : null;
}

export type NodeVersionResult = { ok: boolean; problems: string[] };

/**
 * Every source must parse, and all majors must agree.
 *
 * An unparseable source is a failure rather than a skip: the whole point is
 * that nobody is watching these four places, so "I could not read it" and "it
 * disagrees" have identical consequences.
 */
export function checkNodeVersion(sources: NodeVersionSource[]): NodeVersionResult {
  const problems: string[] = [];

  const unparsed = sources.filter((s) => s.major === null);
  for (const source of unparsed) {
    problems.push(
      `${source.label}: could not read a Node major from ${JSON.stringify(source.raw)}`
    );
  }

  const parsed = sources.filter((s) => s.major !== null);
  const majors = [...new Set(parsed.map((s) => s.major))];
  if (majors.length > 1) {
    const detail = parsed.map((s) => `${s.label}=${s.major}`).join(', ');
    problems.push(
      `Node major disagrees across sources: ${detail}. ` +
        `CI would run one version while the image ships another.`
    );
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Formats the result for a CI log. Returns an exit code.
 *
 * The success line names the sources that were ACTUALLY compared, not a fixed
 * list. It used to hardcode "…engines and @types/node", which then claimed
 * `@types/node` had been checked on a repo with no npm lockfile — where the
 * source is deliberately skipped. An all-clear that overstates its own coverage
 * is the failure mode this whole check exists to prevent.
 */
export function formatResult(
  result: NodeVersionResult,
  agreedMajor: number | null,
  sources: NodeVersionSource[] = []
): number {
  if (result.ok) {
    const what =
      sources.length > 0 ? sources.map((s) => s.label).join(', ') : 'every declared source';
    console.log(`Node major consistent across ${what} (${agreedMajor}).`);
    return 0;
  }
  console.error('Node version consistency check failed:');
  for (const problem of result.problems) console.error(`  ${problem}`);

  // The evidence, per source. A disagreement previously printed only
  // `label=major`, so an operator could see `@types/node (resolved)=26` with
  // nothing to say where the 26 came from — a declared range, a transitive
  // copy, a stale lockfile. `raw` is built to answer exactly that and was only
  // ever shown for sources that failed to parse.
  if (sources.length > 0) {
    console.error('');
    console.error('Read from:');
    for (const source of sources) {
      console.error(`  ${source.label}: ${source.raw}`);
    }
  }
  console.error(
    '\nUpdate all five together: .nvmrc, Dockerfile, Dockerfile.dev, ' +
      'package.json engines.node, package.json devDependencies["@types/node"].'
  );
  console.error(
    'Moving @types/node also means updating the Dependabot `ignore` entry that ' +
      'holds it at the runtime major.'
  );
  return 1;
}
