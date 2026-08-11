/**
 * `libc` restoration rules for `package-lock.json` — pure, no IO.
 *
 * ## What breaks
 *
 * `libc` is the only field distinguishing a musl build from a glibc one:
 * `@img/sharp-linux-x64` and `@img/sharp-linuxmusl-x64` are otherwise both just
 * `os: ["linux"], cpu: ["x64"]`. Production here is `node:20-alpine` — musl.
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
 * The full packument already stores `libc` in the array form the lockfile
 * wants (`["musl"]`), and it is keyed by exact version — so a backfill cannot
 * move a version by construction. That matters: the 0.8.1 near-miss came from
 * lifting values out of *git history*, where a package may since have moved.
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
 * npm serialises the lockfile with `json-stringify-nice`: these keys first, in
 * this order, then every other key alphabetically — with object-valued keys
 * sorted after scalar ones. Arrays count as scalars. `libc` is not in this
 * list, so it lands alphabetically among the scalars, which is why it appears
 * after `dev` but before `license`.
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
 * Entries worth asking the registry about.
 *
 * Skips the root (`""`), workspace links, and anything not resolved to the
 * public registry — a git or `file:` dependency has no packument, and a
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
    if (
      !placed &&
      !SW_KEY_ORDER.has(key) &&
      (isPlainObject(value) || key.localeCompare('libc', 'en') > 0)
    ) {
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

/**
 * Linux entries with no `libc`, as `name@version`.
 *
 * Not all of them are faults — `@esbuild/linux-*` and `@sentry/cli-linux-*`
 * genuinely declare none upstream, and so does
 * `@unrs/resolver-binding-linux-arm-musleabihf`, which is musl-specific and
 * still says nothing. That last one is why "has a musl sibling, therefore must
 * declare `libc`" is not a safe absolute rule (#549).
 */
export function linuxWithoutLibc(lock: LibcLockfile): string[] {
  const out: string[] = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === '') continue;
    if (!Array.isArray(entry.os) || !entry.os.includes('linux')) continue;
    if (Array.isArray(entry.libc) && entry.libc.length > 0) continue;
    out.push(`${entryName(key, entry) ?? key}@${entry.version ?? '?'}`);
  }
  return out;
}
