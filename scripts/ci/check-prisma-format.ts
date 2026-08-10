/**
 * Prisma schema format check — CLI.
 *
 * The rules, and the reasoning behind each, live in
 * `scripts/ci/prisma-format.ts`. This file exists only so that importing them
 * does not spawn a formatter: the tests over there run against real files, and
 * a module that did real work on import would tie every one of them to the
 * repo's current schema.
 *
 * Usage:
 *   npm run format:prisma:check    # this script
 *   npm run format:prisma          # rewrite the real files
 */

import { checkPrismaFormat, SCHEMA_DIR } from '@/scripts/ci/prisma-format';

// `process.exitCode`, not `process.exit()` — stderr is asynchronous when it is
// a pipe, which it is under both `npm run` and GitHub Actions, and exiting
// discards whatever is still queued.
//
// The relative constant, not an absolute path: `readdirSync` resolves it
// against cwd either way, and it is what the messages should show.
process.exitCode = checkPrismaFormat(SCHEMA_DIR);
