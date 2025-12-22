/**
 * Prisma Type Re-exports
 *
 * Explicit re-exports of Prisma-generated types for better discoverability.
 * Import from this file instead of directly from @prisma/client to:
 * - Improve IDE autocomplete and type hints
 * - Decouple application code from Prisma internals
 * - Make it easier to mock types in tests
 *
 * @example
 * ```typescript
 * // ✅ Good - use this file
 * import { User, Session } from '@/types/prisma';
 *
 * // ❌ Avoid - direct imports scatter dependencies
 * import { User, Session } from '@prisma/client';
 * ```
 */

/**
 * Core Prisma Models
 *
 * Re-exported from @prisma/client for application use
 */
export type { User, Session, Account, Verification } from '@prisma/client';

/**
 * Prisma Namespace
 *
 * Provides access to utility types and type helpers:
 * - Prisma.UserSelect - Field selection types
 * - Prisma.UserInclude - Relation inclusion types
 * - Prisma.UserWhereInput - Query filter types
 * - Prisma.UserCreateInput - Creation payload types
 * - And many more...
 *
 * @example
 * ```typescript
 * import { Prisma } from '@/types/prisma';
 *
 * // Type-safe select
 * const userSelect: Prisma.UserSelect = {
 *   id: true,
 *   name: true,
 *   email: true,
 * };
 *
 * // Type-safe where clause
 * const whereClause: Prisma.UserWhereInput = {
 *   email: { contains: '@example.com' },
 * };
 * ```
 */
export type { Prisma } from '@prisma/client';
