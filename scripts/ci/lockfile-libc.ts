/**
 * `libc` restoration rules for `package-lock.json` — pure, no IO.
 *
 * ## What breaks
 *
 * `libc` is the only field distinguishing a musl build from a glibc one:
 * `@img/sharp-linux-x64` and `@img/sharp-linuxmusl-x64` are otherwise both just
 * `os: ["linux"], cpu: ["x64"]`. Production here is `node:24-alpine` — musl.
 *
 * **npm below 11.11.0 deletes every `libc` field it writes past.** Not a
 * platform quirk: `@npmcli/arborist` gained `libc` in its `pkgMetaKeys` list
 * only in 9.4.0, first shipped in npm 11.11.0. Before that the lockfile writer
 * emits `os` and `cpu` and silently drops `libc`, on macOS, Linux and Alpine
 * alike. Measured on this repo: `npm install --package-lock-only` under npm
 * 11.6.0 is a no-op that still removes 15 lines and adds none.
 *
 * That is how `d5b913fb` took 77 carriers to zero, and why the field kept
 * reappearing — dependabot's runner uses a current npm and writes it back.
 *
 * Newer npm **preserves** `libc` but never **restores** it: once the field is
 * gone the tree is "up to date" and nothing recomputes the metadata. So the
 * repair has to be explicit, which is what this module is for.
 *
 * ## Why the registry is the source
 *
 * The registry's per-version manifest (`/<name>/<version>`) already stores
 * `libc` in the array form the lockfile wants (`["musl"]`), and asking for the
 * exact locked version means a backfill cannot move a version by construction.
 * That matters: the 0.8.1 near-miss came from lifting values out of *git
 * history*, where a package may since have moved.
 *
 * Per-version rather than the whole packument because a packument is a
 * package's entire publish history — `vite`'s is 37 MB — and only one version
 * of it is ever wanted. See `manifestUrl`.
 *
 * Validated by strip-and-restore against `d5b913fb^`, the last lockfile a
 * modern npm wrote: delete all 77 `libc` fields, rebuild them from the
 * registry, and the file comes back **byte-identical**.
 *
 * @see scripts/ci/fix-lockfile-libc.ts — the CLI that fetches and writes
 * @see scripts/ci/lockfile-diff.ts — the diff check that catches a fresh loss
 * @see CONTRIBUTING.md — "Cutting a release that changes dependencies"
 */

/** The public npm registry. Entries resolved elsewhere are left alone. */
export const REGISTRY = 'https://registry.npmjs.org/';

/**
 * npm serialises the lockfile with `json-stringify-nice`, whose comparator
 * checks **object-ness first** and only then consults this preferred-key list:
 *
 * ```js
 * isObj(av) === isObj(bv) ? compare(ak, bk, prefKeys) : isObj(av) ? 1 : -1
 * ```
 *
 * So every scalar precedes every object, *including* a preferred key that
 * happens to be one. Proof from this repo's own npm-written lockfile:
 * `@apm-js-collab/code-transformer-bundler-plugins` is ordered
 * `version, resolved, integrity, license, dependencies, engines` — `license`,
 * a non-preferred scalar, sorts before `dependencies`, which is preferred
 * (index 7) but an object.
 *
 * Arrays count as scalars. `libc` is not in this list, so among the scalars it
 * lands alphabetically — after `dev`, before `license`.
 */
const SW_KEY_ORDER: ReadonlySet<string> = new Set([
  'name',
  'version',
  'lockfileVersion',
  'resolved',
  'integrity',
  'requires',
  'packages',
  'dependencies',
]);

/** One `packages` entry. Only the fields this module reads are named. */
export interface LibcLockPackage {
  name?: string;
  version?: string;
  resolved?: string;
  link?: boolean;
  libc?: string[];
  os?: string[];
  cpu?: string[];
  [key: string]: unknown;
}

/** The parts of a lockfile this module reads. */
export interface LibcLockfile {
  packages?: Record<string, LibcLockPackage>;
  [key: string]: unknown;
}

/** A registry-resolved entry that could carry `libc`. */
export interface LibcCandidate {
  /** The `packages` key, e.g. `node_modules/a/node_modules/foo`. */
  key: string;
  /** The registry name — the alias target, not the install path. */
  name: string;
  version: string;
}

/** Looks up the raw `libc` a registry manifest declares, if any. */
export type LibcLookup = (name: string, version: string) => unknown;

/**
 * The registry name for an entry.
 *
 * `entry.name` wins because an aliased install (`"foo": "npm:bar@1"`) writes
 * the *install path* into the key and the real package into `name`; asking the
 * registry for the path would 404.
 */
export function entryName(key: string, entry: LibcLockPackage): string | null {
  if (typeof entry.name === 'string' && entry.name !== '') return entry.name;
  const marker = 'node_modules/';
  const index = key.lastIndexOf(marker);
  if (index === -1) return null;
  const name = key.slice(index + marker.length);
  return name === '' ? null : name;
}

/**
 * npm's package-name grammar: an optional `@scope/` prefix and a name, where
 * neither part may start with `.` or `_`.
 *
 * Uppercase is allowed on purpose. It is invalid for *new* packages but legal
 * for legacy ones still on the registry (`JSONStream`), and rejecting it would
 * make this tool refuse to run for a fork that depends on one. This repo has
 * none — all 1,252 names are lowercase — so the looser rule costs nothing here
 * and avoids a failure a fork could not diagnose.
 *
 * What it does reject is everything with URL structure: a second `/`, `?`,
 * `#`, `%`, `@` past the scope, whitespace, control characters, and `.` / `..`
 * segments.
 */
const PACKAGE_NAME = /^(?:@[A-Za-z0-9\-~][A-Za-z0-9\-._~]*\/)?[A-Za-z0-9\-~][A-Za-z0-9\-._~]*$/;

/**
 * Whether a name is one the registry could actually have published.
 *
 * `entryName` reads from lockfile keys, so its output is only as well-formed
 * as the file: `node_modules/a/node_modules/x/y/z` yields `x/y/z`, and an
 * aliased entry's `name` is whatever the file says. Callers building a URL
 * must check this first — see `manifestUrl`, where CodeQL caught the earlier
 * version encoding only the first `/` (js/incomplete-sanitization).
 */
export function isValidPackageName(name: string): boolean {
  // npm's own cap. Length is checked separately so the regex stays readable.
  return name.length > 0 && name.length <= 214 && PACKAGE_NAME.test(name);
}

/**
 * A lockfile `version` — semver, optionally with prerelease and build parts.
 *
 * Checked for the same reason as the name: it becomes a URL path segment, and
 * it is read from a file rather than produced by this code.
 */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether a version is one the registry could resolve. */
export function isValidVersion(version: string): boolean {
  return version.length > 0 && version.length <= 256 && VERSION.test(version);
}

/**
 * Entries worth asking the registry about.
 *
 * Skips the root (`""`), workspace links, and anything not resolved to the
 * public registry — a git or `file:` dependency has no registry manifest, and a
 * private registry is not ours to query.
 */
export function libcCandidates(lock: LibcLockfile): LibcCandidate[] {
  const out: LibcCandidate[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '' || entry.link === true) continue;
    if (typeof entry.resolved !== 'string' || !entry.resolved.startsWith(REGISTRY)) continue;
    if (typeof entry.version !== 'string' || entry.version === '') continue;
    const name = entryName(key, entry);
    if (name !== null) out.push({ key, name, version: entry.version });
  }
  return out;
}

/**
 * The array form npm writes, or `null` when the manifest declares nothing.
 *
 * Manifests use both `"musl"` and `["musl"]`; npm normalises to the array.
 * An empty or non-string value is treated as absent rather than written
 * through — a `libc: []` in the lockfile would exclude the package everywhere.
 */
export function normaliseLibc(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  const values = Array.isArray(raw) ? raw : [raw];
  const clean = values.filter((v): v is string => typeof v === 'string' && v !== '');
  return clean.length > 0 ? clean : null;
}

const isPlainObject = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A copy of `entry` with `libc` inserted where npm would have written it.
 *
 * Position is not cosmetic: put it anywhere else and the next write by a
 * current npm reorders the key, turning a one-line diff into churn across
 * every native package.
 */
export function withLibc(entry: LibcLockPackage, libc: string[]): LibcLockPackage {
  const rebuilt: LibcLockPackage = {};
  let placed = false;
  for (const [key, value] of Object.entries(entry)) {
    // Object-ness is checked BEFORE the preferred-key list, mirroring npm's
    // comparator. Gating it on `!SW_KEY_ORDER.has(key)` put `libc` *after*
    // `dependencies` — a preferred key that is an object — for any entry with
    // no later-sorting scalar to stop at. Only two non-root entries in this
    // lockfile lack `license`, so it was latent, but it would have produced
    // exactly the reorder-churn this function exists to prevent, and
    // `check:lockfile` cannot see key order.
    const sortsAfterLibc = !SW_KEY_ORDER.has(key) && key.localeCompare('libc', 'en') > 0;
    if (!placed && (isPlainObject(value) || sortsAfterLibc)) {
      rebuilt.libc = libc;
      placed = true;
    }
    rebuilt[key] = value;
  }
  if (!placed) rebuilt.libc = libc;
  return rebuilt;
}

/** An entry whose existing `libc` disagrees with the registry. */
export interface LibcMismatch {
  key: string;
  have: string[];
  /** Empty when the registry declares no `libc` but the lockfile has one. */
  want: string[];
}

/** The outcome of a backfill. */
export interface LibcRepair {
  /** A new lockfile object; the input is not mutated. */
  lockfile: LibcLockfile;
  added: { key: string; libc: string[] }[];
  /** Entries that already carried the right value. */
  alreadyCorrect: string[];
  /**
   * Reported, never silently overwritten. A disagreement means either the
   * lockfile was hand-edited or the lookup is answering for the wrong version
   * — both worth a human deciding, and neither worth guessing at.
   */
  mismatched: LibcMismatch[];
}

/**
 * Restores every `libc` the registry declares, and changes nothing else.
 *
 * Entries are replaced only where a field is inserted, so untouched packages
 * keep object identity and any assertion of "only `libc` moved" can be made
 * against the result.
 */
export function applyLibc(lock: LibcLockfile, lookup: LibcLookup): LibcRepair {
  const packages: Record<string, LibcLockPackage> = { ...(lock.packages ?? {}) };
  const added: LibcRepair['added'] = [];
  const alreadyCorrect: string[] = [];
  const mismatched: LibcMismatch[] = [];

  for (const { key, name, version } of libcCandidates(lock)) {
    const entry = packages[key];
    const want = normaliseLibc(lookup(name, version));
    const have = Array.isArray(entry.libc) ? entry.libc : null;

    if (want === null) {
      if (have !== null) mismatched.push({ key, have, want: [] });
      continue;
    }
    if (have === null) {
      packages[key] = withLibc(entry, want);
      added.push({ key, libc: want });
    } else if (have.join(',') !== want.join(',')) {
      mismatched.push({ key, have, want });
    } else {
      alreadyCorrect.push(key);
    }
  }

  return { lockfile: { ...lock, packages }, added, alreadyCorrect, mismatched };
}

/** A Linux entry carrying no `libc`. */
export interface BareLinuxEntry {
  /** The `packages` key, so callers can tell whether it was queried. */
  key: string;
  /** `name@version`, for printing. */
  label: string;
}

/**
 * Linux entries with no `libc`.
 *
 * Not all of them are faults — `@esbuild/linux-*` and `@sentry/cli-linux-*`
 * genuinely declare none upstream, and so does
 * `@unrs/resolver-binding-linux-arm-musleabihf`, which is musl-specific and
 * still says nothing. That last one is why "has a musl sibling, therefore must
 * declare `libc`" is not a safe absolute rule (#549).
 *
 * This walks **every** entry, including ones `libcCandidates` skips. The `key`
 * is returned so a caller can separate "the registry declares none" from
 * "never asked" — conflating them told a fork with a private native package
 * that its lockfile was complete.
 */
export function linuxWithoutLibc(lock: LibcLockfile): BareLinuxEntry[] {
  const out: BareLinuxEntry[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '') continue;
    if (!Array.isArray(entry.os) || !entry.os.includes('linux')) continue;
    if (Array.isArray(entry.libc) && entry.libc.length > 0) continue;
    out.push({ key, label: `${entryName(key, entry) ?? key}@${entry.version ?? '?'}` });
  }
  return out;
}
