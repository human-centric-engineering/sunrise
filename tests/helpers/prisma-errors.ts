/**
 * Prisma errors in the shape Prisma 7's driver adapter actually throws.
 *
 * A P2002 from `@prisma/adapter-pg` carries no `meta.target`; it names the
 * collided index under `driverAdapterError.cause.constraint` (t-796). The
 * shape below was captured from the dev DB by colliding on `user_email_key`
 * and `ai_agent_orgId_slug_key`. Build test errors with this, not a
 * hand-written `meta: { target: [...] }`, which no running code ever sees.
 */

import { Prisma } from '@prisma/client';

export function uniqueViolationError(opts: {
  index: string;
  modelName: string;
  table?: string;
}): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${opts.index}\``,
    {
      code: 'P2002',
      clientVersion: '7.0.0',
      meta: {
        modelName: opts.modelName,
        driverAdapterError: {
          name: 'DriverAdapterError',
          cause: {
            originalCode: '23505',
            originalMessage: `duplicate key value violates unique constraint "${opts.index}"`,
            kind: 'UniqueConstraintViolation',
            constraint: { index: opts.index },
            ...(opts.table ? { table: opts.table } : {}),
          },
        },
      },
    }
  );
}
