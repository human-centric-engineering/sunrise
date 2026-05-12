import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Backfill the managed-tag taxonomy from legacy free-text category fields.
 *
 * Idempotent — safe to run multiple times. Reads:
 *   - `AiKnowledgeDocument.category` (single string per document)
 *   - `AiKnowledgeChunk.category` (single string per chunk — covers seeded patterns
 *     where each chunk has its own category and the document-level category is null)
 *   - `AiAgent.knowledgeCategories` (legacy free-text array)
 *
 * Writes:
 *   - `KnowledgeTag` rows (one per distinct category string)
 *   - `AiKnowledgeDocumentTag` rows (every doc carrying a category, plus every doc
 *     whose chunks reference categories the doc itself doesn't carry)
 *   - `AiAgentKnowledgeTag` rows (for every legacy entry on an agent that matches a
 *     real tag — typos are reported as warnings, not errors)
 *   - Flips `AiAgent.knowledgeAccessMode` to `restricted` for every agent that had a
 *     non-empty legacy `knowledgeCategories` array. Empty-array agents stay on the
 *     `full` default, which preserves their pre-feature behaviour.
 *
 * Does NOT touch:
 *   - System-scoped documents (they remain visible to every agent via the resolver's
 *     system-scope passthrough; no per-agent grants needed).
 *   - Legacy columns themselves — Phase 6 drops them after the rest of the feature
 *     proves out.
 */

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

async function main(): Promise<void> {
  logger.info('🏷️  Knowledge-tag backfill starting');

  // 1. Collect every distinct category string from documents + chunks.
  const docCategoryRows = await prisma.aiKnowledgeDocument.findMany({
    where: { category: { not: null } },
    select: { id: true, category: true, scope: true },
  });

  const chunkCategoryRows = await prisma.aiKnowledgeChunk.findMany({
    where: { category: { not: null } },
    select: { documentId: true, category: true },
    distinct: ['documentId', 'category'],
  });

  const agents = await prisma.aiAgent.findMany({
    select: { id: true, slug: true, knowledgeCategories: true },
  });

  const categoryNames = new Set<string>();
  for (const row of docCategoryRows) {
    if (row.category) categoryNames.add(row.category);
  }
  for (const row of chunkCategoryRows) {
    if (row.category) categoryNames.add(row.category);
  }
  for (const agent of agents) {
    for (const name of agent.knowledgeCategories ?? []) {
      const trimmed = name.trim();
      if (trimmed) categoryNames.add(trimmed);
    }
  }

  logger.info(`Found ${categoryNames.size} distinct category names`);

  // 2. Upsert tags (slug = stable cross-environment key).
  const slugByName = new Map<string, string>();
  const idBySlug = new Map<string, string>();
  for (const name of categoryNames) {
    const slug = slugify(name);
    if (!slug) {
      logger.warn(`Skipping unsluggable category name: "${name}"`);
      continue;
    }
    slugByName.set(name, slug);
    const tag = await prisma.knowledgeTag.upsert({
      where: { slug },
      create: { slug, name },
      update: { name }, // refresh name if the slug already existed with a different casing
    });
    idBySlug.set(slug, tag.id);
  }
  logger.info(`Upserted ${idBySlug.size} knowledge tags`);

  // 3. Link documents → tags. A doc gets every tag that any of its chunks reference,
  //    plus its own document-level category if set.
  const docTagsToCreate = new Map<string, Set<string>>(); // documentId → Set<tagId>
  function add(documentId: string, tagId: string): void {
    if (!docTagsToCreate.has(documentId)) docTagsToCreate.set(documentId, new Set());
    docTagsToCreate.get(documentId)!.add(tagId);
  }

  for (const row of docCategoryRows) {
    if (!row.category) continue;
    const slug = slugByName.get(row.category);
    if (!slug) continue;
    const tagId = idBySlug.get(slug);
    if (tagId) add(row.id, tagId);
  }
  for (const row of chunkCategoryRows) {
    if (!row.category) continue;
    const slug = slugByName.get(row.category);
    if (!slug) continue;
    const tagId = idBySlug.get(slug);
    if (tagId) add(row.documentId, tagId);
  }

  let docTagsInserted = 0;
  for (const [documentId, tagIds] of docTagsToCreate) {
    for (const tagId of tagIds) {
      await prisma.aiKnowledgeDocumentTag.upsert({
        where: { documentId_tagId: { documentId, tagId } },
        create: { documentId, tagId },
        update: {},
      });
      docTagsInserted++;
    }
  }
  logger.info(`Linked ${docTagsInserted} document↔tag rows`);

  // 4. For each agent with a non-empty legacy knowledgeCategories, switch to restricted
  //    mode and create AiAgentKnowledgeTag rows. Typos (names that don't slug to any
  //    known tag) are warned about but don't block — the agent still gets restricted, it
  //    just lands with zero tag grants until an operator fixes the typo. That matches the
  //    pre-feature behaviour (typos silently restricted you to nothing).
  let agentsRestricted = 0;
  let agentTagsInserted = 0;
  let typos = 0;
  for (const agent of agents) {
    const legacy = (agent.knowledgeCategories ?? []).map((s) => s.trim()).filter(Boolean);
    if (legacy.length === 0) continue;

    await prisma.aiAgent.update({
      where: { id: agent.id },
      data: { knowledgeAccessMode: 'restricted' },
    });
    agentsRestricted++;

    for (const name of legacy) {
      const slug = slugByName.get(name) ?? slugify(name);
      const tagId = idBySlug.get(slug);
      if (!tagId) {
        logger.warn(
          `Agent ${agent.slug} references unknown legacy category "${name}" — no matching tag, agent will have zero grants for this entry until manually fixed`
        );
        typos++;
        continue;
      }
      await prisma.aiAgentKnowledgeTag.upsert({
        where: { agentId_tagId: { agentId: agent.id, tagId } },
        create: { agentId: agent.id, tagId },
        update: {},
      });
      agentTagsInserted++;
    }
  }

  logger.info('✅ Backfill complete', {
    tagsUpserted: idBySlug.size,
    documentLinks: docTagsInserted,
    agentsRestricted,
    agentTagLinks: agentTagsInserted,
    typos,
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    logger.error('❌ Backfill failed', err);
    return prisma.$disconnect().finally(() => process.exit(1));
  });
