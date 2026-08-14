/**
 * Acknowledged `package-lock.json` decisions — rules.
 *
 * WHY THIS EXISTS: `check:lockfile` gates on three things, and two of them are
 * questions rather than defects. Its own output asks *"Intentional pin, or an
 * accident of recomputing the tree?"* and *"Intentional?"* — with nowhere to
 * answer. `lockfile-diff.ts` names this repo's two direct downgrades (`pin
 * Prisma to ~7.1.0`, `pin jsdom to 26`) as *"both deliberate, both exactly the
 * decision worth surfacing"*, so a yes is the expected outcome of the gate
 * firing. Without a way to record one, the only routes forward are bypassing
 * branch protection or weakening the gate, and both end with it green forever.
 *
 * ## Scope: this gate catches ACCIDENTS
 *
 * That is worth stating, because it decides how much machinery belongs here.
 * The check exists because `/pre-pr` never runs on Dependabot PRs and because
 * npm below 11.11.0 silently strips `libc` (#571) — an unnoticed change, not an
 * adversary. Its own wording ("an accident of recomputing the tree") says so.
 *
 * An earlier draft of this module defended against a *deliberate* two-PR
 * pre-authorisation: land an acknowledgement alone, make the change later, so
 * the second PR's diff shows no sign of a sign-off. Closing that needed a
 * base-revision read and a "new entries must match" rule, and that rule broke
 * every fork-sync PR — inherited upstream entries all read as new, and the
 * failure told fork maintainers to delete upstream's decisions. Four live forks
 * merge this repo.
 *
 * The machinery was removed. Anyone who can land two PRs to game this gate can
 * simply merge the change outright; defending a merge-access threat with a text
 * file was never going to work, and the cost was a real, immediate break for
 * the people the repo is for. What remains is deliberately small.
 *
 * **Lost `libc` / `os` / `cpu` is NOT acknowledgeable.** It is the one risk that
 * is never a decision: npm drops the key on every platform, the lockfile then
 * installs fine locally and wrong on Alpine, and there is a repair
 * (`npm run fix:lockfile-libc`). An ACK there would be a way to ship #571 again
 * with a note attached.
 *
 * ## Format
 *
 * Line-based with `#` comments, matching `.trufflehog-exclude.txt` rather than
 * introducing a TOML/YAML parser for a handful of lines:
 *
 * ```
 * downgrade node_modules/@types/node 26.2.0 -> 24.13.3   # runtime major (#584)
 * overrides adm-zip none -> "^0.6.0"                     # epub2 pins ^0.5.10 (#601)
 * ```
 *
 * Both forms name a transition — `<what> <from> -> <to>` — with the literal
 * `none` for an `overrides` side where the entry does not exist. An override is
 * acknowledged per KEY, so removing one is a separate decision from adding it.
 *
 * An unparseable line is a hard error, not a skipped line. A typo'd ACK that
 * silently does nothing sends someone hunting for why the gate still fires on a
 * change they thought they had signed off.
 *
 * @see scripts/ci/check-lockfile.ts — the CLI that reads the file
 * @see scripts/ci/lockfile-diff.ts — what the risks are and why each gates
 */

/** One acknowledged direct-dependency downgrade. */
export interface DowngradeDecision {
  kind: 'downgrade';
  name: string;
  from: string;
  to: string;
  reason: string;
  line: number;
}

/**
 * One acknowledged `overrides` entry, as a transition of a single key.
 *
 * Keyed on the KEY and both sides, not on the resulting block. An ACK naming
 * only the result cannot distinguish "we added an override" from "we removed
 * the one that was fixing a CVE" — removing a later addition returns the block
 * to an earlier, already-acknowledged shape and passes silently.
 */
export interface OverridesDecision {
  kind: 'overrides';
  /** The `overrides` key, e.g. `adm-zip`. */
  key: string;
  /** JSON of the value on each side; the literal `none` when absent. */
  from: string;
  to: string;
  reason: string;
  line: number;
}

export type LockfileDecision = DowngradeDecision | OverridesDecision;

export interface ParsedDecisions {
  decisions: LockfileDecision[];
  /** Lines that could not be read, with the line number and offending text. */
  errors: string[];
}

/**
 * Splits a line into its directive and its `#` reason.
 *
 * The reason begins at the first `#` **preceded by whitespace or at the start
 * of the line**, not simply the first `#`. An earlier version split on the
 * first one and justified it by asserting no npm range could contain one —
 * which is false: `github:owner/repo#semver:^0.6.0` is a valid override value,
 * and splitting there truncated the payload so the block could never be
 * acknowledged at all.
 */
function splitReason(text: string): { directive: string; reason: string } {
  const match = /(^|\s)#/.exec(text);
  if (!match) return { directive: text.trim(), reason: '' };
  const hash = match.index + match[1].length;
  return { directive: text.slice(0, hash).trim(), reason: text.slice(hash + 1).trim() };
}

/** Parses `.lockfile-decisions`. Takes contents, never a path, so it stays pure. */
export function parseDecisions(text: string): ParsedDecisions {
  const decisions: LockfileDecision[] = [];
  const errors: string[] = [];

  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    const { directive, reason } = splitReason(raw);
    if (directive === '') return; // blank, or a whole-line comment

    const downgrade = /^downgrade\s+(\S+)\s+(\S+)\s*->\s*(\S+)$/.exec(directive);
    if (downgrade) {
      decisions.push({
        kind: 'downgrade',
        name: downgrade[1],
        from: downgrade[2],
        to: downgrade[3],
        reason,
        line,
      });
      return;
    }

    const overrides = /^overrides\s+(\S+)\s+(.+?)\s*->\s*(.+?)$/.exec(directive);
    if (overrides) {
      decisions.push({
        kind: 'overrides',
        key: overrides[1],
        from: overrides[2].trim(),
        to: overrides[3].trim(),
        reason,
        line,
      });
      return;
    }

    errors.push(`line ${line}: cannot read ${JSON.stringify(raw.trim())}`);
  });

  // A decision with no reason is a decision nobody can review later. The whole
  // point of the file is the sentence after the `#`.
  for (const decision of decisions) {
    if (decision.reason === '') {
      errors.push(
        `line ${decision.line}: no reason given — add \`# why\`, including the issue number`
      );
    }
  }

  return { decisions, errors };
}

/** The shape {@link partitionDowngrades} needs from a version change. */
export interface AcknowledgeableDowngrade {
  name: string;
  from: string;
  to: string;
}

/**
 * Splits gated downgrades into the acknowledged and the still-gating.
 *
 * Matching is on `(name, from, to)` — all three, as a JSON tuple so no
 * delimiter can collide. A decision naming the right package but the wrong
 * versions does not match, and the downgrade still gates. That exactness is
 * what keeps an entry from becoming a blanket exemption for its package, and
 * what makes a stale entry harmless enough to leave in place: it cannot cover a
 * change it does not name.
 */
export function partitionDowngrades<T extends AcknowledgeableDowngrade>(
  downgrades: T[],
  decisions: LockfileDecision[]
): { acknowledged: T[]; gating: T[] } {
  const acked = new Set(
    decisions
      .filter((d): d is DowngradeDecision => d.kind === 'downgrade')
      .map((d) => JSON.stringify([d.name, d.from, d.to]))
  );

  const acknowledged: T[] = [];
  const gating: T[] = [];
  for (const change of downgrades) {
    const key = JSON.stringify([change.name, change.from, change.to]);
    (acked.has(key) ? acknowledged : gating).push(change);
  }
  return { acknowledged, gating };
}

/** The shape {@link acknowledgedOverrideKeys} needs from an override change. */
export interface AcknowledgeableOverride {
  key: string;
  from: string | null;
  to: string | null;
}

/** The literal written in the file for a side where the entry does not exist. */
export const OVERRIDE_ABSENT = 'none';

/**
 * The `overrides` keys whose exact transition is acknowledged.
 *
 * Each changed key needs its own line, naming both sides. Removing an override
 * is therefore a separate decision from adding it — which is the point: a
 * revert that drops a CVE-fixing override is exactly as much of a decision as
 * adding it was, and an ACK keyed on the resulting block would have waved it
 * through.
 */
export function acknowledgedOverrideKeys(
  changes: AcknowledgeableOverride[],
  decisions: LockfileDecision[]
): string[] {
  const acked = new Set(
    decisions
      .filter((d): d is OverridesDecision => d.kind === 'overrides')
      .map((d) => JSON.stringify([d.key, d.from, d.to]))
  );
  return changes
    .filter((change) =>
      acked.has(
        JSON.stringify([change.key, change.from ?? OVERRIDE_ABSENT, change.to ?? OVERRIDE_ABSENT])
      )
    )
    .map((change) => change.key);
}

/**
 * Decisions that matched nothing in this diff.
 *
 * Reported, never gating. Once the PR that introduced an entry merges, the
 * change is in history rather than in the next PR's diff, so gating on unused
 * entries would fail every subsequent PR. The file is a decision log.
 */
export function unusedDecisions(
  decisions: LockfileDecision[],
  usedLines: ReadonlySet<number>
): LockfileDecision[] {
  return decisions.filter((d) => !usedLines.has(d.line));
}
