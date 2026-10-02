/**
 * Knowledge Base Seeder
 *
 * Two phases for the platform's patterns knowledge (`patterns-knowledge.ts`):
 *
 * Phase 1 — materialisePatternsKnowledge(): writes the calling org's copy of
 * the document and its chunks, with embedding=null and status='ready'. No
 * external dependency. The platform-agent reconcile runs it in every org
 * (§116 t-726); seedChunks() runs it for the org a seed or an admin is in.
 *
 * Phase 2 — embedChunks(): finds the org's chunks where embedding IS NULL,
 * batches them through the configured embedding provider, and writes vectors
 * back.
 */

import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { readFile } from 'fs/promises';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import type { TenancyClient } from '@/lib/db/tenancy-extension';
import { serviceAccountWhere } from '@/lib/auth/account';
import { logger, type Logger } from '@/lib/logging';
import { getOrCreateDefaultKnowledgeBase } from '@/lib/orchestration/knowledge/document-manager';
import { buildDocumentSlugBase } from '@/lib/orchestration/knowledge/document-slug';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';
import {
  PATTERNS_DOCUMENT_FILE_NAME,
  PATTERNS_DOCUMENT_NAME,
  PATTERNS_TAG_SLUG,
} from '@/lib/orchestration/knowledge/patterns-knowledge';
import { requireOrgId } from '@/lib/tenancy/context';

/** Shape of a chunk entry in the pre-parsed chunks.json */
const seedChunkMetadataSchema = z.object({
  type: z.string(),
  section: z.string().optional(),
  section_title: z.string().optional(),
  pattern_number: z.number().optional(),
  pattern_name: z.string().optional(),
  pattern_id: z.string().optional(),
  category: z.string().optional(),
  complexity: z.string().optional(),
  related_patterns: z.array(z.string()).optional(),
  keywords: z.string().optional(),
  source: z.string().optional(),
});

export const seedChunkSchema = z.object({
  id: z.string(),
  chunk_id: z.number(),
  content: z.string(),
  metadata: seedChunkMetadataSchema,
  estimated_tokens: z.number(),
});

export type SeedChunk = z.infer<typeof seedChunkSchema>;

/**
 * Validate parsed chunk-file content. `source` names where it came from in
 * the error, e.g. the file path.
 */
export function parseSeedChunks(parsed: unknown, source: string): SeedChunk[] {
  const result = z.array(seedChunkSchema).safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '<root>';
    throw new Error(
      `Invalid chunks.json at ${source}: ${issue?.message ?? 'validation failed'} (at ${path})`
    );
  }
  return result.data;
}

/**
 * The committed `chunks.json`, from the bundle rather than the file system:
 * the reconcile that calls this runs in the app (org creation, the
 * maintenance job) as well as in the seed, and a module import is the one
 * path every bundler and runtime is sure to carry. Loaded on first call, so
 * nothing that merely imports this module pays for it.
 */
export async function loadPatternsChunks(): Promise<SeedChunk[]> {
  const bundled: { default: unknown } = await import('@/prisma/seeds/data/chunks/chunks.json');
  return parseSeedChunks(bundled.default, 'prisma/seeds/data/chunks/chunks.json');
}

/** How an org's copy stood. */
export type PatternsKnowledgeOutcome =
  /** The org had no copy, and now has this one. */
  | 'created'
  /** The org already holds this version. */
  | 'present'
  /**
   * The org holds a copy of an earlier `chunks.json`, which is left as it is:
   * replacing it would drop the org's embeddings. The seeder has never
   * refreshed a copy.
   */
  | 'outdated';

export interface MaterialiseOptions {
  /** The client to write through. The seed passes its own (owner DSN). */
  db?: TenancyClient;
  log?: Logger;
}

/**
 * Phase 1 — give the calling org its copy of the patterns knowledge (no
 * embeddings).
 *
 * Writes one `AiKnowledgeDocument` named "Agentic Design Patterns" into the
 * org's own default knowledge base, with every chunk (patterns and reference
 * material), and links it to the managed `agentic-design-patterns` tag. The
 * tag is global; the agents that search the document hold it, and the
 * platform-agent reconcile grants it. A tag, not a document grant, because
 * the document is per org and the tag is not.
 *
 * History: an earlier iteration split this into one-doc-per-pattern and
 * lifted every `chunk.category` into a separate tag. That fragmented the
 * KB list into 22 rows and produced 10+ redundant tags pointing at the same
 * doc, so it was reverted — one doc, one tag.
 *
 * **Idempotent by slug.** The slug is the document's per-org key and carries
 * its content hash, so an org that holds this version is left alone. An
 * earlier version is left alone too (`'outdated'`): any `scope: 'system'`
 * document, whatever an admin renamed it to, since only this seeder writes
 * that scope and every copy holds the same fixed chunk keys. Whatever its
 * status: a copy whose re-chunk failed still holds its embedded chunks, and
 * is the admin's to retry. Document, chunks and tag link are one
 * transaction, so a failure leaves no partial copy, and a run that loses the
 * race to write it (the document's per-org slug key) reports `'present'`.
 *
 * Runs in the caller's org scope; every row it writes is stamped with it.
 */
export async function materialisePatternsKnowledge(
  chunks: readonly SeedChunk[],
  options: MaterialiseOptions = {}
): Promise<{ outcome: PatternsKnowledgeOutcome; documentId: string }> {
  const db = options.db ?? prisma;
  const log = options.log ?? logger;
  const orgId = requireOrgId();

  const fileHash = createHash('sha256')
    .update(chunks.map((c) => c.content).join(''))
    .digest('hex');
  // The same helper as uploads, so every environment keys this document
  // identically and grants on it round-trip.
  const slug = buildDocumentSlugBase(PATTERNS_DOCUMENT_NAME, fileHash);

  // This version by its key, and any earlier one by its scope, which only
  // the platform writes: not by name, which an admin can change. An earlier
  // copy missed here would meet this one's chunk keys on every run.
  const copies = await db.aiKnowledgeDocument.findMany({
    where: { orgId, OR: [{ slug }, { scope: 'system' }] },
    select: { id: true, slug: true },
    orderBy: { createdAt: 'asc' },
  });

  const current = copies.find((c) => c.slug === slug);
  if (current) return { outcome: 'present', documentId: current.id };
  if (copies.length > 0) {
    log.warn('An earlier copy of the patterns knowledge is left in place', {
      orgId,
      documentId: copies[0].id,
      heldSlug: copies[0].slug,
      currentSlug: slug,
    });
    return { outcome: 'outdated', documentId: copies[0].id };
  }

  // The service account owns platform content; any user is the fallback on
  // an install that has not seeded one yet.
  const owner =
    (await db.user.findFirst({ where: serviceAccountWhere, select: { id: true } })) ??
    (await db.user.findFirst({ select: { id: true } }));
  if (!owner) {
    throw new Error('No users found in database. Create a user first, then re-run the seeder.');
  }

  const knowledgeBaseId = await getOrCreateDefaultKnowledgeBase(db);
  const tag = await db.knowledgeTag.upsert({
    where: { slug: PATTERNS_TAG_SLUG },
    create: {
      slug: PATTERNS_TAG_SLUG,
      name: PATTERNS_DOCUMENT_NAME,
      description:
        'Built-in reference: the 21 agentic design patterns and supporting material. Grant this tag to any agent that should be able to consult the patterns playbook.',
    },
    update: {},
  });

  const write = db.$transaction(
    async (tx) => {
      const document = await tx.aiKnowledgeDocument.create({
        data: {
          slug,
          name: PATTERNS_DOCUMENT_NAME,
          fileName: PATTERNS_DOCUMENT_FILE_NAME,
          fileHash,
          scope: 'system',
          status: 'ready',
          uploadedBy: owner.id,
          chunkCount: chunks.length,
          knowledgeBaseId,
        },
      });

      // One statement, stamped with the org by the chokepoint. No embedding
      // is written, so nothing here needs the raw `::vector` INSERT uploads use.
      await tx.aiKnowledgeChunk.createMany({
        data: chunks.map((chunk) => ({
          chunkKey: chunk.id,
          documentId: document.id,
          content: chunk.content,
          chunkType: chunk.metadata.type,
          patternNumber: chunk.metadata.pattern_number ?? null,
          patternName: chunk.metadata.pattern_name ?? null,
          section: chunk.metadata.section_title ?? chunk.metadata.section ?? null,
          keywords: chunk.metadata.keywords ?? null,
          estimatedTokens: chunk.estimated_tokens,
          metadata: {
            complexity: chunk.metadata.complexity ?? null,
            relatedPatterns: chunk.metadata.related_patterns ?? null,
            patternId: chunk.metadata.pattern_id ?? null,
            source: chunk.metadata.source ?? null,
          },
        })),
      });

      await tx.aiKnowledgeDocumentTag.create({
        data: { documentId: document.id, tagId: tag.id },
      });
      return document.id;
    },
    // Past the 5 s default for a 191-row insert on a slow remote database.
    { timeout: 30_000 }
  );
  let documentId: string;
  try {
    documentId = await write;
  } catch (err) {
    // Another run wrote the copy first and this one met its slug key. Any
    // other unique violation (another document holding the fixed chunk keys)
    // leaves no copy to show for it, and is thrown.
    const winner =
      err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
        ? await db.aiKnowledgeDocument.findFirst({ where: { orgId, slug }, select: { id: true } })
        : null;
    if (!winner) throw err;
    log.info('Patterns knowledge written concurrently by another run', {
      orgId,
      documentId: winner.id,
    });
    return { outcome: 'present', documentId: winner.id };
  }

  log.info('Patterns knowledge written (chunks only, no embeddings)', {
    orgId,
    documentId,
    chunkCount: chunks.length,
  });
  return { outcome: 'created', documentId };
}

/**
 * Seed the patterns knowledge into the org this runs in, from a chunk file:
 * the `007-knowledge-chunks` seed unit (the install org) and
 * `POST /knowledge/seed` (the admin's org — at `multi`, the install org only:
 * the route declares `writesSharedSettings`, because the `lastSeededAt` stamp
 * below is on the shared settings row; §107 t-751). Every org gets its own
 * copy from the platform-agent reconcile anyway. See
 * {@link materialisePatternsKnowledge}.
 *
 * @param chunksJsonPath - Absolute path to the chunks.json file
 */
export async function seedChunks(chunksJsonPath: string): Promise<void> {
  logger.info('Starting knowledge base seed (chunks only)', { chunksJsonPath });

  const raw = await readFile(chunksJsonPath, 'utf-8');
  const chunks = parseSeedChunks(JSON.parse(raw), chunksJsonPath);
  logger.info('Loaded chunks from file', { count: chunks.length });

  const { outcome, documentId } = await materialisePatternsKnowledge(chunks);
  if (outcome !== 'created') {
    logger.info('Knowledge base already seeded, skipping', { documentId, outcome });
    return;
  }

  // Record the seed timestamp on the settings singleton (upsert to handle
  // the case where settings haven't been lazily created yet).
  await prisma.aiOrchestrationSettings.upsert({
    where: { slug: 'global' },
    create: { slug: 'global', defaultModels: {}, lastSeededAt: new Date() },
    update: { lastSeededAt: new Date() },
  });

  logger.info('Knowledge base seeded successfully (chunks only, no embeddings)', {
    documentId,
    chunkCount: chunks.length,
    tag: PATTERNS_TAG_SLUG,
  });
}

/**
 * Phase 2 — Generate embeddings for all unembedded chunks.
 *
 * Finds every chunk where embedding IS NULL, batches them through the
 * configured embedding provider, and writes vectors back. Can be called
 * repeatedly — only processes chunks that still need embeddings.
 *
 * The calling org's chunks only: at `multi` the chokepoint runs each query,
 * the raw ones included, under the org's `app.current_org`, and the app role
 * the runtime connects as is subject to the policies, so they hide every
 * other org's rows. It needs an org to run in there (the embeddings script
 * enters the install org). With no embedding provider it throws, as it always
 * has.
 *
 * @returns Summary of what was processed
 */
export async function embedChunks(): Promise<{
  processed: number;
  total: number;
  alreadyEmbedded: number;
}> {
  const total = await prisma.aiKnowledgeChunk.count();

  const pending = await prisma.$queryRawUnsafe<Array<{ id: string; content: string }>>(
    `SELECT id, content FROM ai_knowledge_chunk WHERE embedding IS NULL ORDER BY id`
  );

  if (pending.length === 0) {
    logger.info('All chunks already embedded', { total });
    return { processed: 0, total, alreadyEmbedded: total };
  }

  logger.info('Starting embedding generation', {
    pending: pending.length,
    total,
  });

  const texts = pending.map((c) => c.content);
  const { embeddings, provenance } = await embedBatch(texts, undefined, undefined, {
    metadata: { kind: 'knowledge_seed', chunkCount: pending.length },
  });

  for (let i = 0; i < pending.length; i++) {
    const embeddingStr = `[${embeddings[i].join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE ai_knowledge_chunk
       SET embedding = $1::vector,
           "embeddingModel" = $3,
           "embeddingProvider" = $4,
           "embeddingDimension" = $5,
           "embeddedAt" = $6
       WHERE id = $2`,
      embeddingStr,
      pending[i].id,
      provenance.model,
      provenance.provider,
      provenance.dimensions,
      provenance.embeddedAt
    );
  }

  const alreadyEmbedded = total - pending.length;
  logger.info('Embedding generation complete', {
    processed: pending.length,
    total,
    alreadyEmbedded,
  });

  return { processed: pending.length, total, alreadyEmbedded };
}
