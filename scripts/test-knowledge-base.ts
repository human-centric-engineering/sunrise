/* eslint-disable no-console, @typescript-eslint/explicit-function-return-type -- CLI script */
/**
 * Test script for the knowledge base seeder and search.
 *
 * Usage: npx tsx scripts/test-knowledge-base.ts [--seed-only] [--search-only]
 *
 * Requires:
 * - A running PostgreSQL with the sunrise database
 * - For search: an embedding provider (OPENAI_API_KEY or Ollama running)
 * - For seed-only mode: no embedding provider needed (inserts without embeddings)
 */

import { resolve } from 'path';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { z } from 'zod';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { seedChunkSchema } from '@/lib/orchestration/knowledge/seeder';

// Load env from .env.local
config({ path: resolve(__dirname, '../.env.local') });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const DOCUMENT_NAME = 'Agentic Design Patterns';
const CHUNKS_PATH = resolve(__dirname, '../lib/orchestration/seed/chunks.json');

async function ensureTestUser(): Promise<string> {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (existing) return existing.id;

  const user = await prisma.user.create({
    data: {
      name: 'Test Admin',
      email: 'admin@test.local',
      role: 'ADMIN',
      emailVerified: true,
    },
  });
  console.log(`  Created test admin user: ${user.id}`);
  return user.id;
}

async function seedWithoutEmbeddings(): Promise<void> {
  console.log('\n--- Seeding knowledge base (without embeddings) ---\n');

  // Check if already seeded
  const existing = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: DOCUMENT_NAME },
  });
  if (existing) {
    console.log(`  Already seeded (document ${existing.id}, ${existing.chunkCount} chunks)`);
    return;
  }

  const userId = await ensureTestUser();

  // Read chunks
  const raw = await readFile(CHUNKS_PATH, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  const result = z.array(seedChunkSchema).safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join('.') ?? '<root>';
    throw new Error(
      `Invalid chunks.json at ${CHUNKS_PATH}: ${issue?.message ?? 'validation failed'} (at ${path})`
    );
  }
  const chunks = result.data;
  console.log(`  Loaded ${chunks.length} chunks from chunks.json`);

  // Create document
  const contentForHash = chunks.map((c) => c.content).join('');
  const fileHash = createHash('sha256').update(contentForHash).digest('hex');

  const document = await prisma.aiKnowledgeDocument.create({
    data: {
      name: DOCUMENT_NAME,
      fileName: 'agentic-design-patterns.md',
      fileHash,
      status: 'processing',
      uploadedBy: userId,
    },
  });

  // Insert chunks without embeddings
  for (const chunk of chunks) {
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

  await prisma.aiKnowledgeDocument.update({
    where: { id: document.id },
    data: { status: 'ready', chunkCount: chunks.length },
  });

  console.log(`  Seeded ${chunks.length} chunks (document ${document.id})`);
}

async function verifyData(): Promise<void> {
  console.log('\n--- Verifying data ---\n');

  // Check document
  const doc = await prisma.aiKnowledgeDocument.findFirst({
    where: { name: DOCUMENT_NAME },
  });
  console.log(`  Document: ${doc?.name} (status: ${doc?.status}, chunks: ${doc?.chunkCount})`);

  // Check chunk counts by type
  const typeCounts = await prisma.aiKnowledgeChunk.groupBy({
    by: ['chunkType'],
    _count: true,
    orderBy: { _count: { chunkType: 'desc' } },
  });
  console.log('  Chunks by type:');
  for (const tc of typeCounts) {
    console.log(`    ${tc.chunkType}: ${tc._count}`);
  }

  // Check Pattern 12 specifically
  const pattern12 = await prisma.aiKnowledgeChunk.findMany({
    where: { patternNumber: 12 },
    select: { section: true, estimatedTokens: true, chunkType: true },
    orderBy: { chunkKey: 'asc' },
  });
  console.log(`\n  Pattern 12 (Exception Handling) chunks: ${pattern12.length}`);
  for (const chunk of pattern12) {
    console.log(`    - ${chunk.section} (${chunk.estimatedTokens} tokens, ${chunk.chunkType})`);
  }

  // Keyword search test (no embeddings needed)
  const keywordResults = await prisma.aiKnowledgeChunk.findMany({
    where: {
      OR: [
        { keywords: { contains: 'error' } },
        { keywords: { contains: 'failure' } },
        { keywords: { contains: 'recovery' } },
      ],
    },
    select: { patternNumber: true, patternName: true, section: true },
    take: 10,
  });
  console.log(`\n  Keyword search for "error/failure/recovery": ${keywordResults.length} results`);
  for (const r of keywordResults) {
    console.log(`    - Pattern ${r.patternNumber}: ${r.patternName} [${r.section}]`);
  }
}

async function testVectorSearch(): Promise<void> {
  console.log('\n--- Testing vector search ---\n');

  // Check if any chunks have embeddings
  const withEmbedding = await prisma.$queryRawUnsafe<[{ count: bigint }]>(
    `SELECT count(*) as count FROM ai_knowledge_chunk WHERE embedding IS NOT NULL`
  );
  const embeddingCount = Number(withEmbedding[0].count);

  if (embeddingCount === 0) {
    console.log('  No embeddings found. To test vector search:');
    console.log('  1. Set OPENAI_API_KEY in .env.local, OR');
    console.log('  2. Run Ollama locally (ollama serve && ollama pull nomic-embed-text)');
    console.log('  3. Configure an AiProviderConfig for the embedding provider');
    console.log('  Then run: npx tsx scripts/test-knowledge-base.ts --search-only');
    return;
  }

  console.log(`  ${embeddingCount} chunks have embeddings`);

  // Dynamic import to avoid loading env validation in seed-only mode
  const { searchKnowledge } = await import('../lib/orchestration/knowledge/search');

  const query = 'how do I handle errors in my agent';
  console.log(`  Searching: "${query}"`);

  const results = await searchKnowledge(query, undefined, 5);
  console.log(`  Found ${results.length} results:\n`);

  for (const r of results) {
    console.log(
      `  [${r.similarity.toFixed(3)}] Pattern ${r.chunk.patternNumber ?? '-'}: ${r.chunk.patternName ?? r.chunk.chunkType} — ${r.chunk.section ?? ''}`
    );
    console.log(`           ${r.chunk.content.slice(0, 120)}...\n`);
  }

  // Verify Pattern 12 appears
  const hasPattern12 = results.some((r) => r.chunk.patternNumber === 12);
  console.log(
    hasPattern12
      ? '  ✅ Pattern 12 (Exception Handling) found in results!'
      : '  ⚠️  Pattern 12 not in top 5 — try increasing limit or adjusting threshold'
  );
}

async function main() {
  const args = process.argv.slice(2);
  const seedOnly = args.includes('--seed-only');
  const searchOnly = args.includes('--search-only');

  try {
    if (!searchOnly) {
      await seedWithoutEmbeddings();
    }

    await verifyData();

    if (!seedOnly) {
      await testVectorSearch();
    }

    console.log('\n--- Done ---\n');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
