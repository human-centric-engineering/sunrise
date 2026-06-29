/**
 * agent-versioning — server-side helpers for the AiAgentVersion timeline.
 *
 * The version model is **point-in-time**: `AiAgentVersion.snapshot` holds the
 * agent's full versioned config *as of* that version (the post-save state), and
 * `version` numbers increase monotonically per agent. So "restore to vN" means
 * "make the agent exactly as it was at vN", the newest row always equals the
 * live config, and the create/seed paths capture an explicit `v1`
 * ("Initial configuration") so the original is a first-class, restorable entry.
 *
 * These helpers centralise the two things every version-writing path needs — the
 * snapshot shape and the next version number — so create, PATCH, restore, and the
 * seed backfill can never disagree on either. The snapshot whitelist itself comes
 * from the agent field registry (via {@link extractSnapshotFromAgent}), so a new
 * versioned field flows through here automatically.
 *
 * Server-only: imports `@/lib/db/client` types transitively via the caller and is
 * never bundled into client components (unlike `agent-version-diff`, which is
 * pure and client-safe).
 */
import type { Prisma } from '@prisma/client';

import { extractSnapshotFromAgent } from '@/lib/orchestration/agent-version-diff';

/** Change summary for the explicit original version written at create/seed time. */
export const INITIAL_VERSION_SUMMARY = 'Initial configuration';

/**
 * Build a point-in-time snapshot from an agent row plus its resolved knowledge
 * grant id arrays. The grants aren't columns on `AiAgent` (they live in join
 * tables) but are versioned by value, so they're injected before extraction. Ids
 * are sorted so a snapshot is order-stable regardless of grant insertion order.
 */
export function buildAgentSnapshot(
  agent: Record<string, unknown>,
  grants: { grantedTagIds: string[]; grantedDocumentIds: string[] }
): Record<string, unknown> {
  return extractSnapshotFromAgent({
    ...agent,
    grantedTagIds: [...grants.grantedTagIds].sort(),
    grantedDocumentIds: [...grants.grantedDocumentIds].sort(),
  });
}

/** Minimal client surface these helpers touch — satisfied by both the base
 *  client and a `$transaction` client, so callers can pass either. */
type AgentVersionClient = {
  aiAgentVersion: {
    findFirst: (args: {
      where: { agentId: string };
      orderBy: { version: 'desc' };
      select: { version: true };
    }) => Promise<{ version: number } | null>;
  };
};

/**
 * Next version number for an agent (highest existing + 1, or 1 if none). Call
 * inside the same transaction as the version `create` so concurrent writers can't
 * collide on the `@@unique([agentId, version])` constraint.
 */
export async function nextAgentVersionNumber(
  tx: AgentVersionClient,
  agentId: string
): Promise<number> {
  const last = await tx.aiAgentVersion.findFirst({
    where: { agentId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  return (last?.version ?? 0) + 1;
}

/** Cast a built snapshot to the Prisma JSON input type at the write boundary. */
export function asSnapshotJson(snapshot: Record<string, unknown>): Prisma.InputJsonValue {
  return snapshot as Prisma.InputJsonValue;
}
