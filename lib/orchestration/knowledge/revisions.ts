import { isUniqueViolationOn, UNIQUE_CONSTRAINTS } from '@/lib/db/unique-violation';
import { prisma } from '@/lib/db/client';
import { DEFAULT_REVISION_RETENTION } from '@/lib/orchestration/knowledge/revision-retention';

export { DEFAULT_REVISION_RETENTION };

// Append-only revision history for the Document Clean Up flow. Every mutator
// of processedContent — capabilities, human edits, restores, the final
// commit/use-original — writes one row here. See the
// AiKnowledgeDocumentRevision model header for the `source` taxonomy.
//
// version numbers are per-document monotonic and allocated by reading the
// current max. That read and the INSERT that follows are only atomic under a
// lock, so every writer takes a Postgres row lock on the document
// (`lockDocumentRow`) first. Before that lock existed, a parallel tool batch
// from the chat loop — five cleanup capabilities dispatched together by
// Promise.allSettled — had every writer read the same max and collide on the
// (documentId, version) UNIQUE index; the retry below re-read the same stale
// max each round and callers surfaced a raw P2002 to the agent as "there was
// an error processing this step". The retry is kept as a backstop for any
// future writer that reaches here without the row lock.

// Default retention cap is shared with the client-side drawer via
// `revision-retention.ts` so the server prune and the UI hint stay in sync.
// Bounded retention exists because each revision stores the full document
// content (no diff storage), so an unbounded history scales linearly with
// document size × edit count.

// Lower bound — pruning below this loses meaningful undo history. Upper
// bound — beyond this, the storage cost outweighs the diagnostic value.
const MIN_RETENTION = 10;
const MAX_RETENTION = 500;

/**
 * Resolve the per-document revision retention cap. Reads
 * `KB_REVISION_RETENTION` from the environment when set, otherwise falls
 * back to DEFAULT_REVISION_RETENTION. Clamped to a sensible range so a
 * misconfigured env value can't disable history (0) or unbound it (1_000_000).
 */
export function getRevisionRetention(): number {
  const raw = process.env.KB_REVISION_RETENTION;
  if (!raw) return DEFAULT_REVISION_RETENTION;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return DEFAULT_REVISION_RETENTION;
  return Math.max(MIN_RETENTION, Math.min(MAX_RETENTION, parsed));
}

export interface WriteRevisionOpts {
  documentId: string;
  content: string;
  source: string;
  actorId: string | null;
  sectionMarker?: string;
  instructions?: string;
}

export async function nextVersion(documentId: string): Promise<number> {
  return nextVersionWithin(prisma, documentId);
}

/**
 * Any Prisma client that can run the revision queries — the global singleton
 * or an interactive-transaction client. Narrow structural type rather than
 * `Prisma.TransactionClient` so the same helpers accept both.
 */
export type RevisionClient = Pick<
  typeof prisma,
  'aiKnowledgeDocumentRevision' | 'aiKnowledgeDocument' | '$queryRaw'
>;

async function nextVersionWithin(client: RevisionClient, documentId: string): Promise<number> {
  const latest = await client.aiKnowledgeDocumentRevision.findFirst({
    where: { documentId },
    select: { version: true },
    orderBy: { version: 'desc' },
  });
  return (latest?.version ?? 0) + 1;
}

/** The document columns every cleanup mutation needs, read under the row lock. */
export interface LockedDocumentRow {
  id: string;
  status: string;
  originalContent: string | null;
  processedContent: string | null;
  editLockHolder: string | null;
  editLockAcquiredAt: Date | null;
}

/**
 * Take a Postgres row lock (`SELECT … FOR UPDATE`) on the document and return
 * its current cleanup columns. Callers MUST already be inside an interactive
 * transaction — the lock lives until that transaction commits or rolls back.
 *
 * This is the write-serialisation primitive for the whole cleanup surface, and
 * is a different thing from the cooperative `editLock*` columns in
 * `edit-lock.ts`: that lock is a UX-level "another admin is typing" signal with
 * a 5-minute TTL and no database enforcement; this one is held for
 * milliseconds and is what actually makes read-modify-write safe.
 *
 * Returns null when no such document exists.
 */
export async function lockDocumentRow(
  tx: RevisionClient,
  documentId: string
): Promise<LockedDocumentRow | null> {
  const rows = await tx.$queryRaw<LockedDocumentRow[]>`
    SELECT "id", "status", "originalContent", "processedContent",
           "editLockHolder", "editLockAcquiredAt"
    FROM "ai_knowledge_document"
    WHERE "id" = ${documentId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

/**
 * Append a revision using a caller-supplied client, allocating the version
 * from the current max. Safe only while the caller holds the document row
 * lock — see `lockDocumentRow`. Returns the version written.
 */
export async function writeRevisionWithin(
  tx: RevisionClient,
  opts: WriteRevisionOpts
): Promise<number> {
  const version = await nextVersionWithin(tx, opts.documentId);
  await tx.aiKnowledgeDocumentRevision.create({
    data: {
      documentId: opts.documentId,
      version,
      content: opts.content,
      source: opts.source,
      actorId: opts.actorId,
      sectionMarker: opts.sectionMarker,
      instructions: opts.instructions,
    },
  });
  await pruneOldRevisionsWithin(tx, opts.documentId);
  return version;
}

function isVersionConflict(err: unknown): boolean {
  return isUniqueViolationOn(err, UNIQUE_CONSTRAINTS.knowledgeRevisionVersion);
}

const MAX_VERSION_ATTEMPTS = 5;

// Interactive-transaction budgets for cleanup writes. `timeout` has to cover
// the wait for the document row lock as well as the work itself: a parallel
// batch of N capabilities serialises on that lock, so the last one in the
// queue waits for the N-1 transforms ahead of it. `maxWait` is the wait for a
// connection from the pool.
export const CLEANUP_TX_TIMEOUT_MS = 20_000;
export const CLEANUP_TX_MAX_WAIT_MS = 10_000;

/**
 * Append a revision, opening the transaction and taking the row lock itself.
 * Use this from a caller that is not already inside a cleanup transaction
 * (the finalise checkpoint). Callers that also mutate `processedContent` must
 * use `writeCleanupContent` / `mutateCleanupContent` instead, so the read,
 * the transform and both writes share one lock.
 */
export async function writeRevision(opts: WriteRevisionOpts): Promise<void> {
  for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt++) {
    try {
      await prisma.$transaction(
        async (tx) => {
          await lockDocumentRow(tx, opts.documentId);
          await writeRevisionWithin(tx, opts);
        },
        { timeout: CLEANUP_TX_TIMEOUT_MS, maxWait: CLEANUP_TX_MAX_WAIT_MS }
      );
      return;
    } catch (err) {
      if (isVersionConflict(err) && attempt < MAX_VERSION_ATTEMPTS) continue;
      throw err;
    }
  }
}

// Prune revisions beyond the retention cap. Finds the version of the Nth
// most recent revision (where N is the cap) and deletes everything with a
// strictly lower version. Single round-trip per call; safe because the
// cooperative edit lock serialises writers per document.
async function pruneOldRevisionsWithin(client: RevisionClient, documentId: string): Promise<void> {
  const retention = getRevisionRetention();
  const cutoff = await client.aiKnowledgeDocumentRevision.findMany({
    where: { documentId },
    select: { version: true },
    orderBy: { version: 'desc' },
    skip: retention - 1,
    take: 1,
  });
  if (cutoff.length === 0) return;
  await client.aiKnowledgeDocumentRevision.deleteMany({
    where: { documentId, version: { lt: cutoff[0].version } },
  });
}
