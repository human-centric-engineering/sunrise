/**
 * Prisma schema format check — the local half of what CI has always run.
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
 * Printing goes through `console`, not `logger` — see the `scripts/**` override
 * in `eslint.config.mjs`.
 *
 * Usage:
 *   npm run format:prisma:check    # this script
 *   npm run format:prisma          # rewrite the real files
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCHEMA_DIR = 'prisma/schema';

/** Schema files in the given directory, sorted so output is stable. */
export function listSchemaFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.prisma'))
    .sort();
}

/** Returns the names of files the formatter would change. */
export function findUnformatted(schemaDir: string): string[] {
  const files = listSchemaFiles(schemaDir);
  const scratch = mkdtempSync(join(tmpdir(), 'sunrise-prisma-fmt-'));

  try {
    const before = new Map<string, string>();
    for (const name of files) {
      const source = readFileSync(join(schemaDir, name), 'utf8');
      before.set(name, source);
      copyFileSync(join(schemaDir, name), join(scratch, name));
    }

    // The pinned Prisma's own formatter, run over the copy. `--schema` wins
    // over any path in prisma.config.ts, which is what makes the copy work.
    execFileSync('npx', ['prisma', 'format', '--schema', scratch], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return files.filter((name) => readFileSync(join(scratch, name), 'utf8') !== before.get(name));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The message from a thrown value, whatever it turned out to be. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// `process.exitCode`, not `process.exit()` — stderr is asynchronous when it is
// a pipe, which it is under both `npm run` and GitHub Actions, and exiting
// discards whatever is still queued.
// The relative constant, not an absolute path: `readdirSync` resolves it
// against cwd either way, and it is what the messages should show.
process.exitCode = checkPrismaFormat(SCHEMA_DIR);
