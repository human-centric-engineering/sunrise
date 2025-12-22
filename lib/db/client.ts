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
