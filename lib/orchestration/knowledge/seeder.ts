/**
 * Knowledge Base Seeder
 *
 * Two-phase seeder for the knowledge base:
 *
 * Phase 1 — seedChunks(): inserts chunks from chunks.json with embedding=null
 * and creates the document with status='ready'. No external dependency.
 *
 * Phase 2 — embedChunks(): finds all chunks where embedding IS NULL, batches
 * them through the configured embedding provider, and writes vectors back.
 */

import { readFile } from 'fs/promises';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { embedBatch } from '@/lib/orchestration/knowledge/embedder';

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

// Legacy single-document name — kept for the upgrade-detection branch in seedChunks.
const LEGACY_DOCUMENT_NAME = 'Agentic Design Patterns';

// Non-pattern chunks (glossary, getting_started, etc.) are bundled into one reference doc
// so the patterns themselves stay one-doc-per-pattern. Reference docs are always tagged
// 'reference' so an agent can grant or omit them as a group.
const REFERENCE_DOCUMENT_NAME = 'Agentic Design Patterns — Reference Material';
const REFERENCE_TAG_SLUG = 'reference';
const REFERENCE_TAG_NAME = 'Reference Material';

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function upsertTagBySlug(slug: string, name: string): Promise<string> {
  const tag = await prisma.knowledgeTag.upsert({
    where: { slug },
    create: { slug, name },
    update: { name },
  });
  return tag.id;
}

/**
 * Phase 1 — Seed chunks into the knowledge base (no embeddings).
 *
 * Creates one AiKnowledgeDocument per pattern (one document per pattern_number) plus
 * one shared "Reference Material" document for non-pattern chunks (glossary, selection
 * guide, composition recipes, etc.). Each document is linked to the KnowledgeTag(s)
 * matching its chunks' categories so the access-control resolver can grant or deny
 * agents at pattern-level or category-level granularity.
 *
 * Idempotent: skips if any system-scoped pattern documents already exist. If a
 * previous attempt left a failed record with no chunks, that document is cleaned up
 * and re-seeded.
 *
 * Upgrade detection: if the legacy single document `LEGACY_DOCUMENT_NAME` exists, the
 * seeder logs a warning and bails — the operator must delete it before the new layout
 * will be created. We refuse to silently delete it because doing so destroys embeddings
 * (the user's data, which the seeder cannot recompute for free).
 *
 * @param chunksJsonPath - Absolute path to the chunks.json file
 */
export async function seedChunks(chunksJsonPath: string): Promise<void> {
  logger.info('Starting knowledge base seed (chunks only)', { chunksJsonPath });

  const legacy = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: LEGACY_DOCUMENT_NAME },
  });
  if (legacy && legacy.status !== 'failed') {
    logger.warn(
      `Legacy single-document seed detected ("${LEGACY_DOCUMENT_NAME}", id=${legacy.id}). ` +
        'Skipping new-layout seed. Delete the legacy document via the admin UI or `prisma studio` ' +
        'if you want the per-pattern layout — note this drops the existing embeddings.'
    );
    return;
  }
  if (legacy && legacy.status === 'failed') {
    logger.info('Removing previously failed legacy seed document', { documentId: legacy.id });
    await prisma.aiKnowledgeChunk.deleteMany({ where: { documentId: legacy.id } });
    await prisma.aiKnowledgeDocument.delete({ where: { id: legacy.id } });
  }

  // If any of our new-layout pattern documents already exist (status != failed),
  // skip — the seeder is idempotent.
  const existingPattern = await prisma.aiKnowledgeDocument.findFirst({
    where: { scope: 'system', fileName: { startsWith: 'agentic-design-patterns-' } },
  });
  if (existingPattern && existingPattern.status !== 'failed') {
    logger.info('Knowledge base already seeded (new layout), skipping');
    return;
  }

  const raw = await readFile(chunksJsonPath, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const result = z.array(seedChunkSchema).safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '<root>';
    throw new Error(
      `Invalid chunks.json at ${chunksJsonPath}: ${issue?.message ?? 'validation failed'} (at ${path})`
    );
  }
  const chunks = result.data;

  logger.info('Loaded chunks from file', { count: chunks.length });

  const firstAdmin = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    select: { id: true },
  });
  const firstUser = await prisma.user.findFirst({
    select: { id: true },
  });
  const uploaderId = firstAdmin?.id ?? firstUser?.id;

  if (!uploaderId) {
    throw new Error('No users found in database. Create a user first, then re-run the seeder.');
  }

  // Pre-build the tag taxonomy from every distinct category referenced by any chunk.
  // The "reference" tag is added unconditionally so the non-pattern reference doc has a home.
  const distinctCategories = new Set<string>();
  for (const c of chunks) {
    if (c.metadata.category) distinctCategories.add(c.metadata.category);
  }
  const tagIdBySlug = new Map<string, string>();
  for (const name of distinctCategories) {
    const slug = slugify(name);
    if (!slug) continue;
    tagIdBySlug.set(slug, await upsertTagBySlug(slug, name));
  }
  tagIdBySlug.set(
    REFERENCE_TAG_SLUG,
    await upsertTagBySlug(REFERENCE_TAG_SLUG, REFERENCE_TAG_NAME)
  );

  // Group chunks. Pattern-bearing chunks bucket by pattern_number; everything else
  // goes into the shared reference bucket.
  const byPattern = new Map<number, SeedChunk[]>();
  const referenceBucket: SeedChunk[] = [];
  for (const c of chunks) {
    const pn = c.metadata.pattern_number;
    if (typeof pn === 'number') {
      const bucket = byPattern.get(pn) ?? [];
      bucket.push(c);
      byPattern.set(pn, bucket);
    } else {
      referenceBucket.push(c);
    }
  }

  const { createHash } = await import('crypto');
  let totalDocs = 0;
  let totalChunks = 0;

  // Helper: insert a document plus its chunks plus its tag links in one batch.
  async function createDocument(opts: {
    name: string;
    fileName: string;
    chunks: SeedChunk[];
    tagSlugs: Iterable<string>;
  }): Promise<void> {
    const contentForHash = opts.chunks.map((c) => c.content).join('');
    const fileHash = createHash('sha256').update(contentForHash).digest('hex');

    const document = await prisma.aiKnowledgeDocument.create({
      data: {
        name: opts.name,
        fileName: opts.fileName,
        fileHash,
        scope: 'system',
        status: 'ready',
        uploadedBy: uploaderId!,
        chunkCount: opts.chunks.length,
      },
    });

    for (const chunk of opts.chunks) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO ai_knowledge_chunk (
          id, "chunkKey", "documentId", content,
          "chunkType", "patternNumber", "patternName", category,
          section, keywords, "estimatedTokens", metadata
        ) VALUES (
          gen_random_uuid()::text, $1, $2, $3,
          $4, $5, $6, $7, $8, $9, $10, $11::jsonb
        )`,
        chunk.id,
        document.id,
        chunk.content,
        chunk.metadata.type,
        chunk.metadata.pattern_number ?? null,
        chunk.metadata.pattern_name ?? null,
        chunk.metadata.category ?? null,
        chunk.metadata.section_title ?? chunk.metadata.section ?? null,
        chunk.metadata.keywords ?? null,
        chunk.estimated_tokens,
        JSON.stringify({
          complexity: chunk.metadata.complexity ?? null,
          relatedPatterns: chunk.metadata.related_patterns ?? null,
          patternId: chunk.metadata.pattern_id ?? null,
          source: chunk.metadata.source ?? null,
        })
      );
    }

    for (const slug of opts.tagSlugs) {
      const tagId = tagIdBySlug.get(slug);
      if (!tagId) continue;
      await prisma.aiKnowledgeDocumentTag.upsert({
        where: { documentId_tagId: { documentId: document.id, tagId } },
        create: { documentId: document.id, tagId },
        update: {},
      });
    }

    totalDocs++;
    totalChunks += opts.chunks.length;
  }

  // One document per pattern, named "Pattern N: <Name>". Tags = the categories carried
  // by that pattern's chunks (almost always one, but we use a Set to be safe).
  const patternNumbers = [...byPattern.keys()].sort((a, b) => a - b);
  for (const pn of patternNumbers) {
    const chunksForPattern = byPattern.get(pn)!;
    const patternName = chunksForPattern[0].metadata.pattern_name ?? `Pattern ${pn}`;
    const categories = new Set<string>();
    for (const c of chunksForPattern) {
      if (c.metadata.category) categories.add(slugify(c.metadata.category));
    }
    await createDocument({
      name: `Pattern ${pn}: ${patternName}`,
      fileName: `agentic-design-patterns-pattern-${pn}.md`,
      chunks: chunksForPattern,
      tagSlugs: categories,
    });
  }

  // The reference bucket gets its own document tagged 'reference'.
  if (referenceBucket.length > 0) {
    await createDocument({
      name: REFERENCE_DOCUMENT_NAME,
      fileName: 'agentic-design-patterns-reference.md',
      chunks: referenceBucket,
      tagSlugs: [REFERENCE_TAG_SLUG],
    });
  }

  // Record the seed timestamp on the settings singleton (upsert to handle
  // the case where settings haven't been lazily created yet).
  await prisma.aiOrchestrationSettings.upsert({
    where: { slug: 'global' },
    create: { slug: 'global', defaultModels: {}, lastSeededAt: new Date() },
    update: { lastSeededAt: new Date() },
  });

  logger.info('Knowledge base seeded successfully (chunks only, no embeddings)', {
    documents: totalDocs,
    chunks: totalChunks,
    tags: tagIdBySlug.size,
  });
}

/**
 * Phase 2 — Generate embeddings for all unembedded chunks.
 *
 * Finds every chunk where embedding IS NULL, batches them through the
 * configured embedding provider, and writes vectors back. Can be called
 * repeatedly — only processes chunks that still need embeddings.
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
  const { embeddings, provenance } = await embedBatch(texts);

  for (let i = 0; i < pending.length; i++) {
    const embeddingStr = `[${embeddings[i].join(',')}]`;
    await prisma.$executeRawUnsafe(
      `UPDATE ai_knowledge_chunk
       SET embedding = $1::vector,
           "embeddingModel" = $3,
           "embeddingProvider" = $4,
           "embeddedAt" = $5
       WHERE id = $2`,
      embeddingStr,
      pending[i].id,
      provenance.model,
      provenance.provider,
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
