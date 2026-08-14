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
 * that release shipped with 72 missing and every fork inherited them. Nothing
 * was lost between 0.8.0 and 0.8.1. Repaired in #571, which restored 101
 * fields — more than the 77 lost, because dependabot's surgical updates had
 * only ever written the field for entries in the subtrees they touched.
 *
 * Line counts are useless here: a lockfile diff is thousands of lines and says
 * nothing about which packages actually moved. These rules compare the parsed
 * trees instead, and report the four things that carry real risk:
 *
 * 1. **Lost native metadata.** `libc` / `os` / `cpu` tell npm which platform a
 *    binary is for. **npm below 11.11.0 deletes `libc` from every entry it
 *    writes** — not a macOS quirk, as an earlier version of this comment said,
 *    but `@npmcli/arborist` omitting the key from its serialised field list
 *    until 9.4.0. The resulting lockfile installs fine locally and wrong in
 *    production. This is the one that actually happened (#571).
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

/**
 * Stable text for an overrides block, so key order is not a change.
 *
 * Used only to answer "did the block change at all". Acknowledgements do NOT
 * quote this form — they name a per-key transition, because a block-keyed ACK
 * cannot tell adding an override from removing one. It was briefly exported on
 * the assumption that they would; nothing imported it.
 */
function canonicalOverrides(overrides: Manifest['overrides']): string {
  if (overrides === undefined) return 'none';
  return JSON.stringify(
    Object.keys(overrides)
      .sort()
      .map((key) => [key, overrides[key]])
  );
}

/** The per-key transitions between two `overrides` blocks. */
function diffOverrides(base: Manifest['overrides'], head: Manifest['overrides']): OverrideChange[] {
  const text = (value: unknown): string | null =>
    value === undefined ? null : JSON.stringify(value);
  const keys = [...new Set([...Object.keys(base ?? {}), ...Object.keys(head ?? {})])].sort();
  const changes: OverrideChange[] = [];
  for (const key of keys) {
    const from = text(base?.[key]);
    const to = text(head?.[key]);
    if (from !== to) changes.push({ key, from, to });
  }
  return changes;
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

/**
 * One `overrides` entry that was added, removed or re-pointed.
 *
 * The per-KEY delta, not just "the block changed", so the failure names the
 * entry and both sides. That distinction matters for what it makes visible:
 * removing an override that was fixing a CVE walks the patched transitive
 * straight back, and "the overrides block changed" does not tell a reviewer
 * which way it went.
 */
export interface OverrideChange {
  key: string;
  /** `null` when the entry did not exist on that side. */
  from: string | null;
  to: string | null;
}

/** A package whose platform-metadata keys changed in one direction. */
export interface NativeMetadataChange {
  name: string;
  keys: string[];
}

/** @deprecated Kept as the original name for {@link NativeMetadataChange}. */
export type LostNativeMetadata = NativeMetadataChange;

export interface LockfileDiff {
  added: string[];
  removed: string[];
  changed: VersionChange[];
  lostNativeMetadata: NativeMetadataChange[];
  /**
   * Packages that gained `libc`/`os`/`cpu` at the same tree path.
   *
   * Informational — {@link hasRisk} ignores it. Same-path only: a gain across
   * a hoist is indistinguishable from a brand-new package, and reporting every
   * newly-added native package as "gained metadata" would be noise.
   */
  gainedNativeMetadata: NativeMetadataChange[];
  overridesChanged: boolean;
  /** Per-key `overrides` transitions; empty when the block did not change. */
  overrideChanges: OverrideChange[];
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

/** The package name a lockfile key refers to, e.g. `@img/sharp-linux-x64`. */
function packageNameOf(key: string): string | null {
  const marker = 'node_modules/';
  const at = key.lastIndexOf(marker);
  return at === -1 ? null : key.slice(at + marker.length);
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
  const lostNativeMetadata: NativeMetadataChange[] = [];
  const gainedNativeMetadata: NativeMetadataChange[] = [];

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

    // Only losses can *gate* — a package gaining `os`/`cpu`/`libc` is the
    // ecosystem getting more precise, never the failure being guarded against.
    // Sorted, not in declaration order: this text is read by a human comparing
    // one run to another.
    const lost: string[] = nativeKeysOf(before)
      .filter((key) => after[key] === undefined)
      .sort();
    if (lost.length > 0) lostNativeMetadata.push({ name, keys: lost });

    // Gains are still *reported*. Without this the #571 repair — 101 packages
    // regaining `libc`, no version moving — was described by this very tool as
    // "no version or platform-metadata change", which is a plain false
    // statement about the one thing the PR did.
    const gained: string[] = nativeKeysOf(after)
      .filter((key) => before[key] === undefined)
      .sort();
    if (gained.length > 0) gainedNativeMetadata.push({ name, keys: gained });
  }

  // The same check across a HOIST. `npm update` — the operation this rule
  // exists to catch — both restructures the tree and strips metadata, and a
  // package moving from `node_modules/a/node_modules/foo` to
  // `node_modules/foo` is a remove plus an add, so the loop above never
  // compares it. This lockfile has 77 native-metadata entries at nested paths,
  // so the hole covered precisely the packages most likely to move.
  const headByPackageName = new Map<string, { path: string; entry: LockPackage }[]>();
  for (const [path, entry] of Object.entries(headPackages)) {
    const short = packageNameOf(path);
    if (short === null) continue;
    const bucket = headByPackageName.get(short);
    if (bucket) bucket.push({ path, entry });
    else headByPackageName.set(short, [{ path, entry }]);
  }

  for (const name of baseNames) {
    if (name in headPackages) continue; // same-path case, handled above
    const short = packageNameOf(name);
    if (short === null) continue;
    const survivors = headByPackageName.get(short);
    if (survivors === undefined) continue; // genuinely removed, not moved

    // Only compare against survivors that are the SAME RESOLUTION. If the
    // version that was removed is no longer installed anywhere, the metadata
    // that went with it described something the tree no longer contains, and
    // an unrelated copy at a different version is not evidence of a loss.
    //
    // Without this, a `react-email` bump that deleted a nested
    // `@react-email/ui` subtree got matched against a top-level copy of
    // `@img/sharp-wasm32` at a *different* version, which had predated it and
    // had never declared `cpu` — reported as "lost cpu". A check that cries
    // wolf on a dependency simply going away is worse than no check, because
    // the next real loss reads the same (#589).
    //
    // Keyed on the version and NOT on "did this path already exist", which was
    // the first attempt and was far too broad: it also silenced the case where
    // a package is annotated on some copies and not others — precisely the
    // state d5b913fb left this repo in — and the annotated copy is deduped into
    // the un-annotated one. That takes the tree from partly guarded to not
    // guarded at all, which is the #571 failure mode, and it must still gate.
    //
    // An entry with no `version` cannot be matched, so it falls through to the
    // check below rather than being skipped: for a supply-chain guard, the safe
    // default is to report.
    //
    // Two independent reasons to keep looking, because keying on the version
    // ALONE was the second wrong answer here: `npm update` bumps and
    // restructures in one operation, so a nested native package that is
    // upgraded while being hoisted has no same-version survivor and was skipped
    // entirely — silencing the exact signature the header calls "the operation
    // this rule exists to catch". A survivor at a path that did not exist in
    // the base is movement, whatever the version says.
    const removedVersion = basePackages[name].version;
    const sameResolutionSurvives =
      removedVersion !== undefined &&
      survivors.some(({ entry }) => entry.version === removedVersion);
    const landedSomewhereNew = survivors.some(({ path }) => !(path in basePackages));
    if (!sameResolutionSurvives && !landedSomewhereNew) continue;

    // Lost only if EVERY surviving copy lacks the key — one intact copy means
    // the metadata is still in the tree. Deliberately still spans *all*
    // survivors, not just the new ones: an old copy that kept the key is proof
    // the tree did not lose it.
    const lost = nativeKeysOf(basePackages[name])
      .filter((key) => survivors.every(({ entry }) => entry[key] === undefined))
      .sort();
    if (lost.length > 0) lostNativeMetadata.push({ name, keys: lost });
  }

  changed.sort((a, b) => a.name.localeCompare(b.name));
  lostNativeMetadata.sort((a, b) => a.name.localeCompare(b.name));
  gainedNativeMetadata.sort((a, b) => a.name.localeCompare(b.name));

  return {
    added,
    removed,
    changed,
    lostNativeMetadata,
    gainedNativeMetadata,
    // Sorted, so alphabetising or reformatting `overrides` is not reported as
    // a semantic change and answered with "Intentional?".
    overridesChanged:
      canonicalOverrides(options.baseOverrides) !== canonicalOverrides(options.headOverrides),
    overrideChanges: diffOverrides(options.baseOverrides, options.headOverrides),
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
  return diff.lostNativeMetadata.length > 0 || diff.overrideChanges.length > 0;
}

/**
 * The direct-dependency downgrades in a diff. Reported prominently; NOT gated.
 *
 * This used to fail the build, on the reasoning that "a version going backwards
 * is how a patched dependency quietly returns to a vulnerable one". Two things
 * make that the wrong gate:
 *
 * 1. **It is a proxy for a risk something else measures exactly.**
 *    `dependency-review-action` runs on every PR at `fail-on-severity: high`
 *    and fails a dependency change that lands on a KNOWN-vulnerable version —
 *    the actual risk, rather than "a number got smaller". `check:audit` covers
 *    the standing tree weekly. This check is deliberately offline, so it can
 *    never answer the vulnerability question itself.
 * 2. **Measured, it has never caught one.** Over all 134 commits that touched
 *    this lockfile there are exactly 2 direct downgrades — `pin Prisma to
 *    ~7.1.0` and `pin jsdom to 26` — and the note on {@link VersionChange.direct}
 *    already calls them "both deliberate, both exactly the decision worth
 *    surfacing". Two firings, two intentional pins, zero accidents. A gate whose
 *    only outcomes are false positives teaches people to route around it, which
 *    is what happened: #584 needed a 250-line acknowledgement mechanism to make
 *    a correct one-line pin mergeable.
 *
 * **What is lost, and where.** `dependency-review` needs the dependency graph
 * and Advanced Security, so it is skipped on private repos — a private fork
 * gets no per-PR check that a downgrade landed somewhere vulnerable. That is
 * why these are still printed loudly, with their own block in the output rather
 * than a line in a list: the signal stays, the false failure goes.
 *
 * Lost `libc`/`os`/`cpu` and `overrides` changes still gate. Both are rare,
 * neither is measurable by another PR-time check, and the first is the one that
 * actually shipped broken (#571).
 */
export function directDowngrades(diff: LockfileDiff): VersionChange[] {
  return diff.changed.filter((change) => change.downgrade && change.direct);
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
