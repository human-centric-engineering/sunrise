/**
 * Whether a Prisma error is a SERIALIZABLE transaction's clash with a
 * concurrent one (`P2034`).
 *
 * Postgres fails the later of two transactions whose reads and writes cannot
 * be ordered as if they ran one after the other. Nothing it wrote is kept, so
 * a route answers 409 and the caller may retry.
 */

import { Prisma } from '@prisma/client';

export function isSerializableConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}
