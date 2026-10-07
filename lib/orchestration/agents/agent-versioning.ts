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
 * seed backfill can never disagree on either. A writer that does not build its
 * own snapshot (agent import, backup restore, instructions revert) uses
 * {@link ensureBaselineVersion} before its write and {@link recordAgentVersion}
 * after it, which read the live row back so the snapshot cannot drift from it. The snapshot whitelist itself comes
 * from the agent field registry (via {@link extractSnapshotFromAgent}), so a new
 * versioned field flows through here automatically.
 *
 * Server-only: imports `@/lib/db/client` types transitively via the caller and is
 * never bundled into client components (unlike `agent-version-diff`, which is
 * pure and client-safe).
 */
import { Prisma } from '@prisma/client';

import type { prisma } from '@/lib/db/client';
import {
  buildChangeSummary,
  diffAgentSnapshots,
  extractSnapshotFromAgent,
} from '@/lib/orchestration/agent-version-diff';

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

/**
 * Prisma `include` value that loads only the id of an agent's newest
 * `AiAgentVersion`, for stamping `AiMessage.agentVersionId` (#811). Every
 * surface that pins a message should load it this way, so they all pin
 * against the same row.
 */
export const LATEST_AGENT_VERSION_ID_INCLUDE = {
  orderBy: { version: 'desc' },
  take: 1,
  select: { id: true },
} as const;

/**
 * Run an agent read in one REPEATABLE READ transaction, so a `versions`
 * include sees the same commit as the agent row. Without it the include is a
 * second SELECT (this schema has no `relationJoins`), and an agent edit that
 * commits between the two would pin a turn running vN to vN+1.
 */
export function readAgentConsistently<T>(
  db: typeof prisma,
  read: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return db.$transaction(read, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    // Wait for a pool connection as long as a plain query would (the pool's
    // `connectionTimeoutMillis`), not Prisma's 2s default, so a busy one-
    // connection pool queues a turn rather than failing it.
    maxWait: 10_000,
  });
}

/**
 * True when `err` is a collision on an agent version number: a concurrent
 * edit to the same agent took the number this write was about to use. The
 * transaction rolled back, so the write can be retried — routes report it as
 * a 409. Any other unique violation is not this, and may never succeed.
 */
export function isAgentVersionConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    // The driver adapter names the model, not the constraint's fields;
    // `@@unique([agentId, version])` is AiAgentVersion's only unique key.
    err.meta?.modelName === 'AiAgentVersion'
  );
}

/**
 * Transaction timeout for a write that versions many agents in one go (a
 * bulk action, an agent import, a backup restore). Each agent costs several
 * round trips, so Prisma's 5s default is too short for a large batch on a
 * remote database.
 */
export const AGENT_BATCH_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * The agent's live versioned config, read back inside `tx`. Sequential, not
 * `Promise.all`: an interactive transaction holds one connection, and `pg`
 * deprecates concurrent queries on a single client.
 */
async function readLiveSnapshot(
  tx: Prisma.TransactionClient,
  agentId: string
): Promise<Record<string, unknown>> {
  const agent = await tx.aiAgent.findUniqueOrThrow({ where: { id: agentId } });
  const tags = await tx.aiAgentKnowledgeTag.findMany({
    where: { agentId },
    select: { tagId: true },
  });
  const documents = await tx.aiAgentKnowledgeDocument.findMany({
    where: { agentId },
    select: { documentId: true },
  });
  return buildAgentSnapshot(agent, {
    grantedTagIds: tags.map((t) => t.tagId),
    grantedDocumentIds: documents.map((d) => d.documentId),
  });
}

/**
 * Before a write to an existing agent: if it has no version rows yet (an agent
 * that predates create-time versioning, or one an older import created), save
 * its current config as v1 ("Initial configuration") so the write does not
 * lose it. A no-op when the agent already has history.
 */
export async function ensureBaselineVersion(
  tx: Prisma.TransactionClient,
  agentId: string,
  createdBy: string
): Promise<void> {
  if ((await nextAgentVersionNumber(tx, agentId)) !== 1) return;
  await tx.aiAgentVersion.create({
    data: {
      agentId,
      version: 1,
      snapshot: asSnapshotJson(await readLiveSnapshot(tx, agentId)),
      changeSummary: INITIAL_VERSION_SUMMARY,
      createdBy,
    },
  });
}

/**
 * After a write that may have changed an agent's versioned config: save the
 * live config (row and grants, read back inside `tx`) as the next version, so
 * the newest version equals what the agent runs. Writes nothing when the live
 * config already equals the newest version. The change summary is `label`
 * followed by the fields that changed, grouped by form tab as a PATCH's are;
 * a first version gets `label` alone. Call inside the same transaction as the
 * write. Returns the version written, or null when nothing changed.
 */
export async function recordAgentVersion(
  tx: Prisma.TransactionClient,
  agentId: string,
  { label, createdBy }: { label: string; createdBy: string }
): Promise<number | null> {
  const snapshot = await readLiveSnapshot(tx, agentId);
  const newest = await tx.aiAgentVersion.findFirst({
    where: { agentId },
    orderBy: { version: 'desc' },
    select: { version: true, snapshot: true },
  });
  let changeSummary = label;
  if (newest) {
    const stored = isRecord(newest.snapshot) ? newest.snapshot : {};
    // Compare only fields both sides record. A snapshot written before a
    // field joined (or left) the registry lacks (or still carries) it, and
    // that is not a change this write made.
    const live = Object.fromEntries(Object.entries(snapshot).filter(([k]) => k in stored));
    const previous = Object.fromEntries(Object.entries(stored).filter(([k]) => k in snapshot));
    const changed = diffAgentSnapshots(live, previous).map((c) => c.field);
    if (changed.length === 0) return null;
    changeSummary = `${label} — ${buildChangeSummary(changed)}`;
  }
  const version = (newest?.version ?? 0) + 1;
  await tx.aiAgentVersion.create({
    data: { agentId, version, snapshot: asSnapshotJson(snapshot), changeSummary, createdBy },
  });
  return version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
