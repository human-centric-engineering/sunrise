/**
 * Prisma schema format rules — the local half of what CI has always run.
 *
 * Prettier has no `.prisma` parser, so `npm run format:check` cannot see this
 * drift. That is not a theoretical gap: a Prisma bump reformats schema files
 * nobody edited (7.9 changed field-type alignment and block-attribute
 * ordering), and until now the only place that surfaced was a CI job named
 * "Lint & format" — a misleading place to look for a Prisma problem, on a
 * branch about something else entirely (#482, then #510).
 *
 * It lands hardest on forks. The `/framework` and `/app` tiers exist so a fork
 * can add `prisma/schema/framework-*.prisma` and `app.prisma`, and those are
 * precisely the files core never reformats, because core never edits them. A
 * Prisma bump upstream silently invalidates the formatting of files only the
 * fork owns.
 *
 * # Why not `prisma format && git diff --exit-code`
 *
 * That is what `ci.yml` did, and it is correct **only on a clean tree**. Run it
 * locally while editing a schema — the exact situation this check exists to
 * help with — and `git diff` reports your own uncommitted work as drift.
 * Verified before writing this: append a perfectly-formatted comment to
 * `app.prisma` and the git-diff form fails.
 *
 * So the check formats a **copy** in a temp directory and compares. It never
 * touches `prisma/schema`, which makes it safe to put in `npm run validate`
 * alongside the other non-mutating checks, and correct regardless of git state.
 * `npm run format:prisma` is the mutating fixer, mirroring `format` /
 * `format:check`.
 *
 * # No side effects on import
 *
 * The CLI lives in `check-prisma-format.ts` — deliberately a separate file,
 * unlike the changelog pair whose tests mock the filesystem. The tests here run
 * against real files and the real formatter, because the whole question is how
 * `prisma format` actually behaves; a module that spawned a subprocess merely
 * because something imported it would make every one of those tests depend on
 * the repo's current schema.
 *
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Where the platform's schema lives, relative to the repo root. */
export const SCHEMA_DIR = 'prisma/schema';

/**
 * Schema files in the given directory, **recursively**, as paths relative to
 * it, sorted so output is stable.
 *
 * Recursive because `prisma format` is: verified against the pinned 7.9.1 that
 * it loads and rewrites `<dir>/sub/widget.prisma`. A flat listing would have
 * been wrong in both directions for a fork that organises its schema into
 * folders — nested files silently unchecked (a regression against the git-diff
 * form this replaces), and a top-level model with a relation into a subfolder
 * failing P1012 against an incomplete copy, reported as a broken schema when
 * the schema is fine.
 */
export function listSchemaFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.prisma'))
    .sort();
}

/**
 * Prisma's own declared entry point, to be run with `process.execPath`.
 *
 * Deliberately not `npx`, and deliberately not the `node_modules/.bin` shim.
 * Both force a shell on Windows — Node refuses to spawn a `.cmd` without one
 * (CVE-2024-27980) — and `shell: true` concatenates argv without escaping it.
 * Node says so itself: passing args alongside it emits DEP0190, "the arguments
 * are not escaped, only concatenated". An earlier draft of this file quoted the
 * binary and missed the one argument that can contain a space, the scratch
 * path: `os.tmpdir()` on Windows sits under `%USERPROFILE%`, so every
 * contributor called "John Smith" would have got `Could not check
 * prisma/schema` on a perfectly formatted schema.
 *
 * Spawning `node <entry>` uses no shell, so nothing needs quoting and there is
 * no platform branch left to get wrong. The path comes from the `bin` field of
 * Prisma's own `package.json` rather than a hardcoded guess, so it survives the
 * package rearranging itself.
 */
export function prismaEntry(root = process.cwd()): string {
  const requireFrom = createRequire(join(root, 'noop.js'));
  const manifestPath = requireFrom.resolve('prisma/package.json');
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin =
    typeof manifest === 'object' &&
    manifest !== null &&
    'bin' in manifest &&
    typeof manifest.bin === 'object' &&
    manifest.bin !== null &&
    'prisma' in manifest.bin
      ? (manifest.bin as Record<string, unknown>).prisma
      : undefined;

  if (typeof bin !== 'string') {
    throw new Error(`prisma/package.json declares no "bin.prisma" (looked in ${manifestPath})`);
  }
  return join(dirname(manifestPath), bin);
}

/** The message from a thrown value, whatever it turned out to be. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Points every path in a formatter message back at the real schema.
 *
 * Prisma reports errors against the copy, and the copy is deleted before the
 * message reaches anyone — so the operator was being handed a file path that
 * no longer existed, for the one failure (a schema that will not parse) this
 * script most needs to make legible.
 *
 * A plain substitution of the scratch path is enough, and that is deliberate.
 * An earlier draft also rewrote the realpath and cwd-relative spellings —
 * Prisma emits a `../../..` form when invoked through `npx`. Invoking the local
 * binary directly (see {@link prismaEntry}) it prints absolute paths only, so
 * that machinery was unreachable and no test could exercise it. If a future
 * Prisma emits another spelling, the end-to-end assertion that no
 * `sunrise-prisma-fmt-` path survives will say so, and it can be added back
 * with evidence rather than in anticipation.
 */
export function rewriteScratchPaths(message: string, scratch: string, schemaDir: string): string {
  return message.split(scratch).join(schemaDir);
}

/** Returns the names of files the formatter would change. */
export function findUnformatted(schemaDir: string): string[] {
  const files = listSchemaFiles(schemaDir);
  const scratch = mkdtempSync(join(tmpdir(), 'sunrise-prisma-fmt-'));

  try {
    const before = new Map<string, string>();
    for (const name of files) {
      before.set(name, readFileSync(join(schemaDir, name), 'utf8'));
      // Subdirectories have to exist in the copy, or a nested schema is simply
      // absent and the copy is not the schema we meant to check.
      mkdirSync(dirname(join(scratch, name)), { recursive: true });
      copyFileSync(join(schemaDir, name), join(scratch, name));
    }

    // The pinned Prisma's own formatter, run over the copy. `--schema` wins
    // over any path in prisma.config.ts, which is what makes the copy work.
    try {
      execFileSync(process.execPath, [prismaEntry(), 'format', '--schema', scratch], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(rewriteScratchPaths(describeError(error), scratch, schemaDir));
    }

    return files.filter((name) => readFileSync(join(scratch, name), 'utf8') !== before.get(name));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Returns the process exit code so every path out is a plain `return`.
 *
 * Takes the directory rather than resolving it, so the failure paths can be
 * exercised against real files in a temp dir instead of a mocked filesystem —
 * a mock here would only assert that this file's author guessed right about
 * how `prisma format` behaves. Every message therefore names `schemaDir`, not
 * the module constant: a function that accepts a directory and then reports a
 * different one is the kind of small lie that costs someone an afternoon.
 */
export function checkPrismaFormat(schemaDir: string): number {
  let unformatted: string[];
  try {
    unformatted = findUnformatted(schemaDir);
  } catch (error) {
    console.error(`Could not check ${schemaDir}`);
    console.error(describeError(error));
    return 1;
  }

  if (unformatted.length > 0) {
    console.error(
      `${unformatted.length} schema file${unformatted.length === 1 ? '' : 's'} not formatted per the pinned Prisma:`
    );
    for (const name of unformatted) console.error(`  ${join(schemaDir, name)}`);
    console.error('');
    console.error("Run 'npm run format:prisma' and commit the result.");
    console.error(
      'A Prisma upgrade can reformat files you never edited — including your own ' +
        'framework-*.prisma / app.prisma if you are a fork.'
    );
    return 1;
  }

  console.log(`${schemaDir} OK (${listSchemaFiles(schemaDir).length} files).`);
  return 0;
}
