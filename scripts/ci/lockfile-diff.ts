/**
 * `package-lock.json` diff rules — pure, no IO.
 *
 * `/pre-pr` builds its file set from `*.ts` / `*.tsx` and scans for TypeScript
 * anti-patterns, so a PR whose entire substance is the lockfile gets a clean
 * bill from a gate that never looked at it. That is not hypothetical: 0.8.1
 * (#538) was exactly such a PR, and `npm update` stripped `libc` from five
 * native Linux packages during the cut. That one was caught by hand before it
 * was committed — measured, `v0.8.0 → v0.8.1` loses metadata on zero packages
 * — but the near-miss is the point: nothing in the pipeline was looking. The
 * irony is pointed, because #538 exists *because* a lockfile problem went
 * unnoticed (#552).
 *
 * The one that was NOT caught is `d5b913fb` (2026-07-29), a dependabot merge
 * that took 77 packages' `libc` to zero. Five were restored before v0.8.0, so
 * that release shipped with 72 missing and every fork inherited them; `main`
 * is still in that state. Nothing was lost between 0.8.0 and 0.8.1 (#571).
 *
 * Line counts are useless here: a lockfile diff is thousands of lines and says
 * nothing about which packages actually moved. These rules compare the parsed
 * trees instead, and report the four things that carry real risk:
 *
 * 1. **Lost native metadata.** `libc` / `os` / `cpu` tell npm which platform a
 *    binary is for. Recomputing the tree on macOS drops them from Linux
 *    packages, and the resulting lockfile installs fine locally and wrong in
 *    production. This is the one that actually happened.
 * 2. **Downgrades of a direct dependency.** A version going backwards is how a
 *    patched dependency quietly returns to a vulnerable one. Only *direct*
 *    ones gate, which is a measured decision rather than a taste — see
 *    {@link VersionChange.direct}.
 * 3. **`overrides` changes**, read from `package.json` at both revisions —
 *    npm does not write them into the lockfile. An override forces a package
 *    past a range its dependents declared. Sunrise carries two deliberately; a
 *    third appearing in a diff is a decision, not a detail.
 * 4. **What moved at all** — added, removed, changed — so a "3 packages plus a
 *    dedupe" claim can be checked rather than believed.
 *
 * @see scripts/ci/check-lockfile.ts — the CLI that reads the files
 * @see CONTRIBUTING.md — "Cutting a release that changes dependencies"
 */

/** The metadata keys that decide which platform a package installs on. */
export const NATIVE_KEYS = ['libc', 'os', 'cpu'] as const;

/** One package entry, narrowed to the fields these rules read. */
export interface LockPackage {
  version?: string;
  libc?: string[];
  os?: string[];
  cpu?: string[];
}

/** The parts of a lockfile these rules read. */
export interface Lockfile {
  packages?: Record<string, LockPackage>;
}

/** The parts of `package.json` these rules read. */
export interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
}

/** Stable text for an overrides block, so key order is not a change. */
function canonicalOverrides(overrides: Manifest['overrides']): string {
  if (overrides === undefined) return 'none';
  return JSON.stringify(
    Object.keys(overrides)
      .sort()
      .map((key) => [key, overrides[key]])
  );
}

/** A package whose version changed, with the direction resolved. */
export interface VersionChange {
  name: string;
  from: string;
  to: string;
  /** True when `to` sorts below `from`. */
  downgrade: boolean;
  /**
   * True when `package.json` names this package directly.
   *
   * The distinction decides whether a downgrade is a decision or an artefact.
   * Measured over all 134 commits that touched this lockfile, each against its
   * own first parent: **2 direct downgrades against 45 transitive ones**, and
   * four commits that would have failed on a transitive downgrade alone. The
   * two direct ones are `fix(deps): pin Prisma to ~7.1.0` and `fix(deps): pin
   * jsdom to 26` — both deliberate, both exactly the decision worth surfacing.
   * The transitive ones are npm re-resolving underneath them.
   *
   * A gate that cries wolf is one people learn to scroll past, so transitive
   * downgrades are printed and not gated.
   *
   * (An earlier draft of this comment quoted 92-against-307 from a probe that
   * paired *successive* lockfile commits rather than each commit with its
   * parent. With merges in the history that manufactures downgrades wherever
   * two branches were developed in parallel. The numbers above replace it.)
   */
  direct: boolean;
}

/** A package that lost one or more platform-metadata keys. */
export interface LostNativeMetadata {
  name: string;
  keys: string[];
}

export interface LockfileDiff {
  added: string[];
  removed: string[];
  changed: VersionChange[];
  lostNativeMetadata: LostNativeMetadata[];
  overridesChanged: boolean;
}

/**
 * Compares two `x.y.z`-ish version strings numerically, segment by segment.
 *
 * Deliberately loose about what follows the numeric core: npm versions carry
 * prerelease and build suffixes this does not try to order, and calling a
 * suffix change a downgrade would cry wolf. Only a numeric segment going
 * backwards counts.
 */
export function isDowngrade(from: string, to: string): boolean {
  const left = from.split('.').map((part) => Number.parseInt(part, 10));
  const right = to.split('.').map((part) => Number.parseInt(part, 10));

  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a !== b) return b < a;
  }
  return false;
}

function nativeKeysOf(entry: LockPackage): (typeof NATIVE_KEYS)[number][] {
  return NATIVE_KEYS.filter((key) => entry[key] !== undefined);
}

/** Everything worth reporting about the move from `base` to `head`. */
export function diffLockfiles(
  base: Lockfile,
  head: Lockfile,
  options: {
    directDependencies?: ReadonlySet<string>;
    /**
     * `overrides` from `package.json` at each revision.
     *
     * **Not from the lockfile.** npm records overrides in the manifest; the
     * word does not appear in `package-lock.json` at all — verified, zero
     * occurrences, and nothing under `packages[""]` either. An earlier version
     * compared `lockfile.overrides` on both sides, which is `undefined` against
     * `undefined` forever, so one of the three gating rules could never fire.
     * The CLI's own message said "package.json overrides changed", which was
     * the tell.
     */
    baseOverrides?: Manifest['overrides'];
    headOverrides?: Manifest['overrides'];
  } = {}
): LockfileDiff {
  const directDependencies = options.directDependencies ?? new Set<string>();
  const basePackages = base.packages ?? {};
  const headPackages = head.packages ?? {};
  const baseNames = Object.keys(basePackages);
  const headNames = new Set(Object.keys(headPackages));

  const added = Object.keys(headPackages)
    .filter((name) => !(name in basePackages))
    .sort();
  const removed = baseNames.filter((name) => !headNames.has(name)).sort();

  const changed: VersionChange[] = [];
  const lostNativeMetadata: LostNativeMetadata[] = [];

  for (const name of baseNames) {
    const before = basePackages[name];
    const after = headPackages[name];
    if (!after) continue;

    if (before.version !== undefined && after.version !== undefined) {
      if (before.version !== after.version) {
        changed.push({
          name,
          from: before.version,
          to: after.version,
          downgrade: isDowngrade(before.version, after.version),
          direct: directDependencies.has(name),
        });
      }
    }

    // Only *losses* count. A package gaining `os`/`cpu` is the ecosystem
    // getting more precise, which is never the failure being guarded against.
    // Sorted, not in declaration order: this text is read by a human comparing
    // one run to another.
    const lost: string[] = nativeKeysOf(before)
      .filter((key) => after[key] === undefined)
      .sort();
    if (lost.length > 0) lostNativeMetadata.push({ name, keys: lost });
  }

  changed.sort((a, b) => a.name.localeCompare(b.name));
  lostNativeMetadata.sort((a, b) => a.name.localeCompare(b.name));

  return {
    added,
    removed,
    changed,
    lostNativeMetadata,
    // Sorted, so alphabetising or reformatting `overrides` is not reported as
    // a semantic change and answered with "Intentional?".
    overridesChanged:
      canonicalOverrides(options.baseOverrides) !== canonicalOverrides(options.headOverrides),
  };
}

/**
 * Whether the diff contains anything a human has to rule on.
 *
 * Note what is **not** here. Added, removed and version-changed packages are
 * reported but do not make a diff notable — every dependency PR moves
 * packages. Neither do *transitive* downgrades, for the reason given on
 * {@link VersionChange.direct}: they are mostly one intended pin propagating,
 * and gating on them would have failed four of this repo's 134 lockfile commits
 * for doing what was asked. They are still printed, so a surprising one is
 * visible; they just do not stop the run.
 */
export function hasRisk(diff: LockfileDiff): boolean {
  return (
    diff.lostNativeMetadata.length > 0 ||
    diff.overridesChanged ||
    diff.changed.some((change) => change.downgrade && change.direct)
  );
}

/**
 * The `node_modules/<name>` keys `package.json` names directly.
 *
 * All four kinds. Sunrise has no `optionalDependencies` or `peerDependencies`
 * today, but a fork that does would have had a downgrade there classified
 * transitive and never gated — the exact "patched package returns to a
 * vulnerable one" case the rule exists for.
 */
export function directDependencyKeys(manifest: Manifest): Set<string> {
  return new Set(
    Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }).map((name) => `node_modules/${name}`)
  );
}
