import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { env } from '@/lib/env';
import { withTenancy, type TenancyClient } from '@/lib/db/tenancy-extension';
import { getTenantContext, isMultiTenant } from '@/lib/tenancy/context';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

/**
 * Prisma Client Singleton
 *
 * Best practice for Next.js to prevent multiple instances of Prisma Client in development.
 * In production, this creates a single instance.
 * In development, this reuses the same instance across hot reloads.
 *
 * Prisma 7 requires a database adapter to be passed to the client constructor.
 *
 * @see .context/database/schema.md for database schema documentation
 * @see .context/environment/reference.md for DATABASE_URL configuration
 */

/**
 * Tenancy seam.
 *
 * This single module is the chokepoint every `prisma` importer inherits. The
 * client exported below is the base client wrapped by `withTenancy`
 * (`lib/db/tenancy-extension.ts`): every create of a tenant-owned row is
 * stamped with the org the request entered, and at `TENANCY_MODE=multi` every
 * operation runs inside a transaction that first issues
 * `set_config('app.current_org', <org>, true)` for the `org_isolation`
 * policies to read — an op that needs an org and has none throws before any
 * SQL. At `single` (the default) the install org is the only answer and no
 * `set_config` is ever issued; behaviour is otherwise identical to a template
 * with no tenancy concept at all.
 *
 * Setting `multi` is the data-plane half of the capability. It is correct
 * only with the policies enabled (`npm run db:tenancy:enable`) and the app
 * connecting as a `NOBYPASSRLS` role that does not own the tables — see
 * `.context/architecture/multi-tenancy-design.md` and
 * `.context/tenancy/context.md`.
 *
 * The read-side owner predicate is §115 `f-mt-owner-predicate`, a later
 * `$extends` layer over this one; nothing here builds toward it.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: TenancyClient | undefined;
  pool: Pool | undefined;
};

/**
 * Connection pool (reused across hot reloads in development).
 *
 * `max` defaults to 10 — node-postgres's own default, and the right size for
 * Sunrise's documented deploy target: a single long-running process
 * (docker-compose, Render, Railway) that genuinely wants a warm pool.
 *
 * A function-per-request platform is the opposite case. Each warm instance
 * holds its own pool, so 20 instances × 10 = 200 connections against a Postgres
 * that may allow far fewer — surfacing as intermittent `too many connections`
 * errors that correlate with traffic rather than with any one query. Those
 * deploys set `DATABASE_POOL_MAX=1` and put a transaction pooler in front
 * (PgBouncer, Neon `-pooler`, Supabase `:6543`, Vercel `POSTGRES_PRISMA_URL`);
 * the pooler multiplexes, so one connection per instance is plenty.
 *
 * `connectionTimeoutMillis` matters independently of `max`: without it a request
 * that cannot get a connection hangs until the platform kills it, instead of
 * failing fast with a usable error.
 */
const pool =
  globalForPrisma.pool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX ?? 10,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

if (env.NODE_ENV !== 'production') globalForPrisma.pool = pool;

// Create Prisma adapter
const adapter = new PrismaPg(pool);

/**
 * The tenancy-extended client every importer receives.
 *
 * `lib/tenancy/context.ts` imports `prisma` back from here for `forEachOrg`
 * — the one import cycle this module takes part in. It is safe in either
 * load order because this side reads only hoisted function declarations
 * from `context.ts`, and that side reads `prisma` only inside `forEachOrg`,
 * never at evaluation.
 */
export const prisma: TenancyClient =
  globalForPrisma.prisma ??
  withTenancy(
    new PrismaClient({
      adapter,
      log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
    }),
    { isMultiTenant, getTenantContext, installOrgId: INSTALL_ORG_ID }
  );

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
