import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { env } from '@/lib/env';

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
 * This single module is the chokepoint every `prisma` importer inherits, which
 * is exactly where a multi-tenant fork plugs in. At `TENANCY_MODE=single` (the
 * default) this is a no-op — behaviour is identical to a template with no
 * tenancy concept at all.
 *
 * The template does NOT implement multi-tenancy. Setting `multi` fails loud
 * here rather than letting unscoped queries run with no isolation. A fork that
 * wants multi-tenancy removes this guard and wraps the exported client so every
 * tenant-scoped call runs inside a `$transaction` that first issues
 * `SET LOCAL app.current_org = '<org-id>'` (per-transaction, never per-session —
 * the pool recycles connections). The full retrofit recipe, the proven RLS
 * policy, and the gotchas are in `.context/architecture/multi-tenancy.md`.
 */
if (env.TENANCY_MODE === 'multi') {
  throw new Error(
    'TENANCY_MODE=multi is not implemented by the Sunrise template. Multi-tenancy ' +
      'requires the Postgres-RLS retrofit documented in .context/architecture/multi-tenancy.md ' +
      '(wrap this client so every tenant-scoped call runs inside a $transaction that issues ' +
      'SET LOCAL app.current_org). Complete that work and remove this guard, or set TENANCY_MODE=single.'
  );
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  pool: Pool | undefined;
};

// Create connection pool (reuse across hot reloads in development)
const pool = globalForPrisma.pool ?? new Pool({ connectionString: env.DATABASE_URL });

if (env.NODE_ENV !== 'production') globalForPrisma.pool = pool;

// Create Prisma adapter
const adapter = new PrismaPg(pool);

// Create Prisma client
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
