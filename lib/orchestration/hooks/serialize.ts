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

  // Redact header values in action to prevent auth token leakage
  let safeAction = rest.action;
  if (safeAction && typeof safeAction === 'object' && !Array.isArray(safeAction)) {
    const action = safeAction as Record<string, unknown>;
    if (action.headers && typeof action.headers === 'object') {
      safeAction = {
        ...action,
        headers: Object.fromEntries(
          Object.keys(action.headers as Record<string, string>).map((k) => [k, '••••••••'])
        ),
      };
    }
  }

  return { ...rest, action: safeAction, hasSecret: row.secret !== null };
}
