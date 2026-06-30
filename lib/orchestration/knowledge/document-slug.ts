/**
 * Knowledge-document export slug
 *
 * `AiKnowledgeDocument.slug` is the stable cross-environment key used to
 * round-trip agent->document grants through export/import and backup/restore
 * (#338), mirroring `KnowledgeTag.slug`.
 *
 * The slug is DETERMINISTIC — `slugify(name) + '-' + first8(fileHash)` — so the
 * "same" document (same display name + same content) produces the same slug in
 * any environment. That is what lets a grant reconnect after an operator
 * re-ingests the document into the target environment, with no manual key
 * matching. The seeded patterns document derives its slug the same way: its
 * `fileHash` comes from the committed `chunks.json`, so it is identical across
 * environments by construction.
 *
 * `buildDocumentSlugBase` MUST stay in lockstep with the SQL backfill in
 * `prisma/migrations/20260629120000_add_knowledge_document_slug/migration.sql`
 * (lowercase, non-alphanumeric -> '-', trim, cap 60, empty -> 'document', then
 * '-' + 8 hex of the hash). If you change one, change the other, or legacy rows
 * and freshly-created rows will key differently. A parity test in
 * `tests/unit/lib/orchestration/knowledge/document-slug.test.ts` pins the exact
 * output for representative names so a `slugify` change fails loudly.
 *
 * Known limitations (acceptable during 0.x alpha):
 *   - When two *different* documents compute the same base (same name + same
 *     first-8 hex of a different hash — vanishingly rare), the `-N` suffix is
 *     assigned by row id at backfill time, so the loser may key differently
 *     across environments and not round-trip. Grants on the unique-base case
 *     (the overwhelming majority) always round-trip.
 *   - Non-ASCII names assume the database uses a Unicode-default collation, so
 *     SQL `LOWER()` matches JS `toLowerCase()`. Under an exotic collation (e.g.
 *     Turkish `tr_TR`) a backfilled legacy row and a later re-upload of the same
 *     name could diverge. The slugify step strips non-`[a-z0-9]` anyway, so this
 *     only bites names whose lowercase form differs in its ASCII letters.
 */

import { Prisma } from '@prisma/client';
import { slugify } from '@/lib/orchestration/knowledge/chunker';

/** The fallback base when a name slugifies to the empty string. */
const EMPTY_NAME_FALLBACK = 'document';

/**
 * The deterministic, collision-unaware slug for a document. Two documents with
 * the same name and content share this value (they are the same logical
 * document); the create-time uniqueness loop below only ever diverges them when
 * a stale non-`ready` row already holds the slug.
 */
export function buildDocumentSlugBase(name: string, fileHash: string): string {
  const base = slugify(name) || EMPTY_NAME_FALLBACK;
  return `${base}-${fileHash.slice(0, 8)}`;
}

/** Minimal client surface needed to check slug uniqueness (prisma or a tx). */
type SlugLookupClient = {
  aiKnowledgeDocument: {
    findUnique: (args: {
      where: { slug: string };
      select: { id: true };
    }) => Promise<{ id: string } | null>;
  };
};

/**
 * True when `err` is a Prisma unique-constraint violation on the document
 * `slug` column. Used by the upload paths to turn the (narrow) concurrent
 * same-content create race into a dedup instead of an unhandled 500 — two
 * simultaneous uploads of identical content both resolve the same free slug,
 * and the create that loses the race lands here.
 */
export function isDuplicateSlugError(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  return Array.isArray(target)
    ? target.includes('slug')
    : typeof target === 'string' && target.includes('slug');
}

/**
 * Resolve a unique slug for a NEW document. Returns the deterministic base when
 * free; otherwise appends `-2`, `-3`, ... (the same convention the migration's
 * backfill uses for legacy collisions) until an unused slug is found.
 *
 * A collision is rare: dedup returns an existing `ready` document before create,
 * so this only fires when a stale `failed`/`processing`/`pending_review` row
 * already holds the base slug for the same content.
 */
export async function generateUniqueDocumentSlug(
  client: SlugLookupClient,
  name: string,
  fileHash: string,
  excludeId?: string
): Promise<string> {
  const base = buildDocumentSlugBase(name, fileHash);
  let candidate = base;
  let suffix = 2;
  // `excludeId` lets a row keep (or re-derive to) a slug it already owns — the
  // preview-refresh path re-derives a pending_review row's slug after a rename
  // and must not count its own current slug as a collision.
  for (;;) {
    const hit = await client.aiKnowledgeDocument.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!hit || hit.id === excludeId) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
}
