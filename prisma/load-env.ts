/**
 * Load `.env.local` then `.env` into `process.env` — as a side-effect module
 * so it runs BEFORE any import that validates the environment.
 *
 * ES module imports are hoisted and evaluated in order, so a
 * `dotenv.config()` call written above them in `seed.ts` ran only after
 * `@/lib/env` had already thrown for the missing `DATABASE_URL`. Importing
 * this module first is what makes `npm run db:seed` work from a plain shell;
 * under `prisma migrate reset` and in Docker the variables are already
 * exported and both loads are no-ops.
 */
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
