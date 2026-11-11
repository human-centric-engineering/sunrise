/**
 * Known values for the privacy scope (§127): what the layer already knows
 * belongs to the people in a call, so tier B (`core.known-values`) finds
 * them and the ways people write them.
 *
 * Loaded lazily, through the scope's `loadKnownValues`, only when a call is
 * actually scanned: a turn in mode `off` reads nothing.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Tier B*
 */
import { prisma } from '@/lib/db/client';
import { isEmbedUserId } from '@/lib/embed/auth';
import type { KnownValue } from '@/lib/privacy/adapters/types';

/**
 * A loader for the user's own name and email. An embed visitor has no user
 * row, so nothing is known about them. A user who is gone gives nothing.
 */
export function userKnownValues(userId: string): () => Promise<readonly KnownValue[]> {
  return async () => {
    if (isEmbedUserId(userId)) return [];
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    if (!user) return [];
    const values: KnownValue[] = [];
    if (user.name.trim().length > 0) values.push({ type: 'PERSON', value: user.name.trim() });
    if (user.email.length > 0) values.push({ type: 'EMAIL', value: user.email });
    return values;
  };
}
