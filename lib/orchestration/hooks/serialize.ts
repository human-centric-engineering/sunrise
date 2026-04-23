/**
 * Hook serialization helpers.
 *
 * The raw `secret` column is never sent to the admin client — callers
 * read `hasSecret` to know whether signing is configured, and must
 * rotate to get a fresh plaintext value.
 */

import type { Prisma } from '@prisma/client';

export type HookRow = {
  id: string;
  name: string;
  eventType: string;
  action: Prisma.JsonValue;
  filter: Prisma.JsonValue;
  isEnabled: boolean;
  secret: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

export type SafeHook = Omit<HookRow, 'secret'> & { hasSecret: boolean };

export function toSafeHook(row: HookRow): SafeHook {
  const { secret: _secret, ...rest } = row;
  return { ...rest, hasSecret: row.secret !== null };
}
