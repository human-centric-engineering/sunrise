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
 * CI. It is a repair tool run by a human after a dependency change. The
 * automated guard is `npm run check:lockfile`, which catches a *fresh* loss
 * against the base revision.
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  applyLibc,
  libcCandidates,
  linuxWithoutLibc,
  REGISTRY,
  type LibcLockfile,
  type LibcLookup,
} from '@/scripts/ci/lockfile-libc';

const LOCKFILE = 'package-lock.json';

/** Fetches a full packument. `null` means "no such package", not "failed". */
export type PackumentFetcher = (name: string) => Promise<unknown>;

/** Registry URL for a package name; the scope slash must stay encoded. */
export function packumentUrl(name: string): string {
  return REGISTRY + name.replace('/', '%2F');
}

/**
 * The abbreviated packument omits `libc`, so this asks for the full document.
 * Retries because a single dropped response would otherwise silently leave a
 * package bare — the exact failure this tool exists to fix.
 */
export async function fetchPackument(name: string, attempts = 3): Promise<unknown> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(packumentUrl(name));
      if (response.ok) return await response.json();
      if (response.status === 404) return null;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw new Error(
    `registry fetch failed for ${name}: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

/** `versions[v].libc` out of a packument, tolerant of any shape. */
export function libcByVersion(packument: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (packument === null || typeof packument !== 'object') return out;
  const versions = (packument as { versions?: unknown }).versions;
  if (versions === null || typeof versions !== 'object') return out;
  for (const [version, manifest] of Object.entries(versions as Record<string, unknown>)) {
    if (manifest === null || typeof manifest !== 'object') continue;
    const libc = (manifest as { libc?: unknown }).libc;
    if (libc !== undefined) out.set(version, libc);
  }
  return out;
}

/**
 * Fetches every distinct name and returns a lookup over the results.
 *
 * A shared cursor rather than chunking: package counts per name are wildly
 * uneven, and chunking would idle most workers waiting on the slowest batch.
 */
export async function buildLookup(
  names: string[],
  fetcher: PackumentFetcher = fetchPackument,
  concurrency = 16
): Promise<LibcLookup> {
  const index = new Map<string, Map<string, unknown>>();
  const queue = [...names];
  const worker = async (): Promise<void> => {
    for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
      index.set(name, libcByVersion(await fetcher(name)));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return (name, version) => index.get(name)?.get(version);
}

/** Returns the process exit code so every path out is a plain `return`. */
export async function main(
  argv: string[],
  fetcher: PackumentFetcher = fetchPackument
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
  const names = [...new Set(candidates.map((c) => c.name))];
  console.log(
    `${LOCKFILE}: ${candidates.length} registry entries, ${names.length} distinct names.`
  );

  let lookup: LibcLookup;
  try {
    lookup = await buildLookup(names, fetcher);
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

  const bare = linuxWithoutLibc(repair.lockfile);
  console.log(
    `libc: ${repair.alreadyCorrect.length} already correct, ${repair.added.length} to restore.`
  );
  console.log(`Linux packages still declaring no libc: ${bare.length} (upstream declares none).`);

  if (repair.added.length === 0) {
    console.log(`${LOCKFILE} is complete — every registry-declared libc is present.`);
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

// Module scope, matching `check-lockfile.ts`: the tests drive this by setting
// `process.argv` and re-importing. `.catch` is not decoration — an unhandled
// rejection here would exit 0 and report success for a repair that never ran.
main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
