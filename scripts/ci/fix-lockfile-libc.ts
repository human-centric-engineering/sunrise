/**
 * Restores `libc` to `package-lock.json` from the registry — CLI.
 *
 * Needed because npm below 11.11.0 deletes the field on every write and no npm
 * puts it back; the mechanism, and the byte-identical validation behind this
 * approach, are in `scripts/ci/lockfile-libc.ts`.
 *
 * Usage:
 *   npm run fix:lockfile-libc            # rewrite package-lock.json
 *   npm run fix:lockfile-libc -- --check # report only; exit 1 if repair needed
 *
 * This talks to the network, so it is deliberately NOT part of `validate` or
 * the PR pipeline — a gate that depends on the registry fails for reasons that
 * have nothing to do with the change under review.
 *
 * It runs in CI in exactly one place: the **weekly** `dependency-audit`
 * workflow invokes `--check`, which reports and never writes. That is the
 * absolute counterpart to `npm run check:lockfile`, which is a diff check and
 * so cannot see metadata that was already missing before the base revision
 * (#549, #571).
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyLibc,
  isValidPackageName,
  isValidVersion,
  libcCandidates,
  linuxWithoutLibc,
  REGISTRY,
  type LibcLockfile,
  type LibcLookup,
} from '@/scripts/ci/lockfile-libc';

const LOCKFILE = 'package-lock.json';

/**
 * Fetches one version's manifest. `null` means "no such version", not
 * "failed".
 */
export type ManifestFetcher = (name: string, version: string) => Promise<unknown>;

/**
 * Registry URL for one exact version of a package.
 *
 * **Per-version, not the whole packument.** The first version of this tool
 * fetched `registry.npmjs.org/<name>` and picked the version out of it, which
 * downloads a package's entire publish history to read one field: `vite`'s
 * packument is **37 MB** and takes 11.5 s by itself, `better-auth` 8.8 MB.
 * At 16-way concurrency that reliably blew past the request timeout, and two
 * full sweeps died on `vite` specifically. `<name>/<version>` returns **2 KB**
 * and carries `libc` in the same array form — verified against the live
 * endpoint. It is also simply more correct: the version cannot be mis-selected
 * from a history because it is the thing being asked for.
 *
 * Validates before encoding rather than trying to sanitise. The name arm was
 * `name.replace('/', '%2F')`, which encodes only the *first* slash — CodeQL
 * flagged it as `js/incomplete-sanitization`, correctly: the name comes out of
 * a lockfile key, so `node_modules/a/node_modules/x/y/z` hands it `x/y/z`, and
 * nothing enforced the one-slash assumption the line was written on.
 *
 * Throws rather than skipping: a malformed name or version means the lockfile
 * is not what this tool assumes, and quietly omitting that package would leave
 * it bare — the exact fault being repaired. `main` turns this into "nothing
 * written".
 */
export function manifestUrl(name: string, version: string): string {
  if (!isValidPackageName(name)) {
    throw new Error(`refusing to build a registry URL for a malformed package name: ${name}`);
  }
  if (!isValidVersion(version)) {
    throw new Error(`refusing to build a registry URL for a malformed version: ${version}`);
  }
  return `${REGISTRY}${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
}

/**
 * How long one registry request may take before it is abandoned and retried.
 *
 * Node's `fetch` has **no** default request timeout, so without this a single
 * stalled socket parks one of the concurrent workers forever, `Promise.all`
 * never settles, and the tool hangs after printing its first line — with the
 * retry loop, added for exactly this failure, never getting a turn. Observed:
 * one run of this script sat past ten minutes and had to be killed.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The abbreviated packument omits `libc`, so this asks for the full manifest.
 * Retries because a single dropped response would otherwise silently leave a
 * package bare — the exact failure this tool exists to fix.
 */
export async function fetchManifest(
  name: string,
  version: string,
  attempts = 5,
  baseDelayMs = 500
): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(manifestUrl(name, version), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) return await response.json();
      if (response.status === 404) return null;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      // A malformed name is a fact about the lockfile, not a flaky network —
      // retrying it just delays the same failure.
      if (error instanceof Error && error.message.startsWith('refusing to build')) throw error;
      lastError = error;
    }
    // Exponential with jitter, not linear. One failed name aborts the whole
    // repair, and a sweep is ~1,250 requests at 16-way concurrency, so a rare
    // connection blip is near-certain to hit *some* name. The previous
    // 250/500/750ms schedule put all three attempts inside the same ~1.5s
    // window and lost two runs in a row to it, on different packages each
    // time. This spans ~15s instead, and the jitter stops 16 workers
    // retrying in lockstep.
    const backoff = baseDelayMs * 2 ** attempt;
    await new Promise((r) => setTimeout(r, backoff + Math.floor(backoff * 0.25 * Math.random())));
  }
  throw new Error(
    `registry fetch failed for ${name}@${version}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

/** `libc` out of one version's manifest, tolerant of any shape. */
export function libcOf(manifest: unknown): unknown {
  if (manifest === null || typeof manifest !== 'object') return undefined;
  return (manifest as { libc?: unknown }).libc;
}

/**
 * Fetches every distinct name@version and returns a lookup over the results.
 *
 * Keyed by name **and** version because the same package can sit at two
 * versions in one tree (`@napi-rs/canvas` is here at 0.1.80 and 1.0.3) and
 * `libc` is a per-version fact.
 *
 * A shared cursor rather than chunking: response times are uneven, and
 * chunking would idle most workers waiting on the slowest batch.
 */
export async function buildLookup(
  pairs: { name: string; version: string }[],
  fetcher: ManifestFetcher = fetchManifest,
  concurrency = 16
): Promise<LibcLookup> {
  const index = new Map<string, unknown>();
  const seen = new Set<string>();
  const queue: { name: string; version: string }[] = [];
  for (const pair of pairs) {
    const key = `${pair.name}@${pair.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push(pair);
  }

  const worker = async (): Promise<void> => {
    for (let pair = queue.pop(); pair !== undefined; pair = queue.pop()) {
      const libc = libcOf(await fetcher(pair.name, pair.version));
      if (libc !== undefined) index.set(`${pair.name}@${pair.version}`, libc);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return (name, version) => index.get(`${name}@${version}`);
}

/** Returns the process exit code so every path out is a plain `return`. */
export async function main(
  argv: string[],
  fetcher: ManifestFetcher = fetchManifest
): Promise<number> {
  const checkOnly = argv.includes('--check');
  const path = resolve(process.cwd(), LOCKFILE);

  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`Could not read ${LOCKFILE}`);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  let lock: LibcLockfile;
  try {
    lock = JSON.parse(source) as LibcLockfile;
  } catch (error) {
    console.error(`Could not parse ${LOCKFILE}`);
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  // Prove the writer is byte-faithful BEFORE trusting it with the real file.
  // If a round-trip is not identity, writing would smuggle in formatting
  // changes across 1,538 entries and bury the `libc` additions in the diff.
  if (JSON.stringify(lock, null, 2) + '\n' !== source) {
    console.error(`${LOCKFILE} does not survive a JSON round-trip unchanged.`);
    console.error('Refusing to write: the repair would carry unrelated formatting churn.');
    return 1;
  }

  const candidates = libcCandidates(lock);
  const distinct = new Set(candidates.map((c) => `${c.name}@${c.version}`)).size;
  console.log(
    `${LOCKFILE}: ${candidates.length} registry entries, ${distinct} distinct name@version.`
  );

  let lookup: LibcLookup;
  try {
    lookup = await buildLookup(candidates, fetcher);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Nothing written — a partial index would leave packages bare.');
    return 1;
  }

  const repair = applyLibc(lock, lookup);

  for (const { key, have, want } of repair.mismatched) {
    console.error(
      `  ! ${key} declares libc ${JSON.stringify(have)}, registry says ${want.length ? JSON.stringify(want) : 'none'}`
    );
  }
  if (repair.mismatched.length > 0) {
    console.error('Refusing to overwrite a value that disagrees with the registry — check these.');
    return 1;
  }

  console.log(
    `libc: ${repair.alreadyCorrect.length} already correct, ${repair.added.length} to restore.`
  );

  // Split by whether the registry was actually consulted. `linuxWithoutLibc`
  // walks the whole lockfile, but `libcCandidates` skips git, `file:` and
  // private-registry entries — calling those "upstream declares none" asserts
  // an answer to a question never asked. A fork with a private native package
  // would have been told its lockfile was complete.
  const asked = new Set(candidates.map((c) => c.key));
  const bare = linuxWithoutLibc(repair.lockfile);
  const checked = bare.filter((entry) => asked.has(entry.key));
  const unchecked = bare.filter((entry) => !asked.has(entry.key));

  console.log(
    `Linux packages still declaring no libc: ${checked.length} (registry declares none).`
  );
  if (unchecked.length > 0) {
    console.log(
      `  plus ${unchecked.length} not resolved from ${REGISTRY} — not checked, so unknown:`
    );
    for (const entry of unchecked) console.log(`    ? ${entry.label}`);
  }

  if (repair.added.length === 0) {
    // "Complete" only covers what was asked about. Saying it flatly while
    // holding unchecked entries is the same overclaim as the line above.
    console.log(
      unchecked.length === 0
        ? `${LOCKFILE} is complete — every registry-declared libc is present.`
        : `${LOCKFILE} is complete for everything checked; the ${unchecked.length} above are unknown.`
    );
    return 0;
  }

  for (const { key, libc } of repair.added) console.log(`  + ${key} ${JSON.stringify(libc)}`);

  if (checkOnly) {
    console.error('');
    console.error(
      `${repair.added.length} libc field(s) missing. Run \`npm run fix:lockfile-libc\`.`
    );
    return 1;
  }

  writeFileSync(path, JSON.stringify(repair.lockfile, null, 2) + '\n');
  console.log(`\nWrote ${LOCKFILE} — ${repair.added.length} libc field(s) restored.`);
  return 0;
}

/**
 * Whether this file is the script being run, rather than one being imported.
 *
 * `check-lockfile.ts` runs at module scope unguarded and that is fine there —
 * it is synchronous, read-only, and re-importing it costs nothing. This module
 * is neither: importing it would fire 1,252 registry requests and a
 * `writeFileSync` over a tracked file, using the *importer's* argv and cwd.
 * Every helper here is exported, which invites exactly that import.
 *
 * Exported so the guard itself is testable rather than a line nothing covers.
 */
export function isDirectRun(scriptPath: string | undefined): boolean {
  return (
    scriptPath !== undefined && /(?:^|[\\/])fix-lockfile-libc\.(?:ts|js|mjs|cjs)$/.test(scriptPath)
  );
}

if (isDirectRun(process.argv[1])) {
  // `.catch` is not decoration — an unhandled rejection here would exit 0 and
  // report success for a repair that never ran.
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
