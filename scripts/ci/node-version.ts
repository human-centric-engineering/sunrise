/**
 * Node major-version consistency — rules.
 *
 * WHY THIS EXISTS: the Node major is stated in four places that no tool
 * reconciles — `.nvmrc` (what CI installs), `Dockerfile` and `Dockerfile.dev`
 * (what ships), and `engines.node` (what forks are told). #581 collapsed eight
 * hardcoded CI pins (six in `ci.yml`, two in `dependency-audit.yml`) down to
 * `.nvmrc`, but the remaining four are structurally
 * unavoidable: a `FROM` line cannot read `.nvmrc`, and npm cannot read a
 * Dockerfile.
 *
 * The failure that motivates this is silent and asymmetric. Bump `.nvmrc`
 * alone and every CI job goes green on the new major while the image that
 * actually serves traffic still builds the old one — the tests pass *because*
 * they are no longer testing what ships. That is the same shape as the drift
 * this check's own PR set out to remove, so leaving it unguarded would have
 * been the change congratulating itself.
 *
 * NOT checked: `@types/node`. It is a fifth declaration of the Node version and
 * it currently disagrees — `^26` against a `>=24` runtime — so `tsc` will
 * accept APIs that throw in the production image. That is a real gap, but it is
 * pre-existing and fixing it means moving a types major, which can surface
 * unrelated errors; folding it in here would have turned a consistency check
 * into a dependency change. Tracked separately rather than silently omitted.
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

/** Formats the result for a CI log. Returns an exit code. */
export function formatResult(result: NodeVersionResult, agreedMajor: number | null): number {
  if (result.ok) {
    console.log(
      `Node major consistent across .nvmrc, both Dockerfiles and engines (${agreedMajor}).`
    );
    return 0;
  }
  console.error('Node version consistency check failed:');
  for (const problem of result.problems) console.error(`  ${problem}`);
  console.error(
    '\nUpdate all four together: .nvmrc, Dockerfile, Dockerfile.dev, package.json engines.node.'
  );
  return 1;
}
