/**
 * Admin Orchestration — Knowledge graph data
 *
 * GET /api/v1/admin/orchestration/knowledge/graph
 *
 * Builds a hierarchical node/link graph for the knowledge base:
 * central KB node → document nodes → chunk nodes (if total < 500).
 *
 * Query params:
 *   scope  — "system" | "app" (optional, omit for all)
 *   view   — "structure" | "embedded" (default: "structure")
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import type { GraphNode, GraphLink, GraphCategory, GraphStats } from '@/types/orchestration';

/** Threshold for showing individual chunk nodes */
const CHUNK_NODE_THRESHOLD = 500;

const CATEGORIES: GraphCategory[] = [
  { name: 'Knowledge Base' },
  { name: 'Document (Ready)' },
  { name: 'Document (Pending)' },
  { name: 'Document (Failed)' },
  { name: 'Chunk' },
];

function documentCategoryIndex(status: string): number {
  switch (status) {
    case 'ready':
      return 1;
    case 'failed':
      return 3;
    default:
      return 2; // pending, processing
  }
}

const graphQuerySchema = z.object({
  scope: z.enum(['system', 'app']).optional(),
  view: z.enum(['structure', 'embedded']).default('structure'),
});

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);

  const { scope, view } = validateQueryParams(searchParams, graphQuerySchema);
  const embeddedOnly = view === 'embedded';

  // Build document filter
  const docWhere: Prisma.AiKnowledgeDocumentWhereInput = {};
  if (scope) docWhere.scope = scope;

  // Fetch documents with chunk counts
  const documents = await prisma.aiKnowledgeDocument.findMany({
    where: docWhere,
    include: { _count: { select: { chunks: true } } },
  });

  const documentIds = documents.map((d) => d.id);

  // Build chunk filter
  const chunkWhere: Prisma.AiKnowledgeChunkWhereInput = {
    documentId: { in: documentIds },
  };
  if (embeddedOnly) {
    // pgvector Unsupported columns can't be filtered via Prisma directly,
    // so we use a raw query for embedded-only aggregate stats
  }

  // Aggregate chunk stats per document
  // For embedded view, we only count chunks that have embeddings
  interface ChunkAggregate {
    documentId: string;
    _sum: { estimatedTokens: number | null };
    _count: { id: number };
  }

  let chunkAggregates: ChunkAggregate[];

  if (embeddedOnly) {
    // Raw query because Prisma can't filter on Unsupported("vector") columns
    const rawAggs = await prisma.$queryRaw<
      Array<{ documentId: string; chunk_count: bigint; total_tokens: bigint }>
    >`
      SELECT "documentId", COUNT(id) AS chunk_count, COALESCE(SUM("estimatedTokens"), 0) AS total_tokens
       FROM ai_knowledge_chunk
       WHERE "documentId" = ANY(${documentIds}::text[]) AND embedding IS NOT NULL
       GROUP BY "documentId"
    `;
    chunkAggregates = rawAggs.map((r) => ({
      documentId: r.documentId,
      _sum: { estimatedTokens: Number(r.total_tokens) },
      _count: { id: Number(r.chunk_count) },
    }));
  } else {
    const results = await prisma.aiKnowledgeChunk.groupBy({
      by: ['documentId'],
      where: chunkWhere,
      _sum: { estimatedTokens: true },
      _count: { id: true },
    });
    chunkAggregates = results.map((r) => ({
      documentId: r.documentId,
      _sum: { estimatedTokens: r._sum.estimatedTokens },
      _count: { id: r._count.id },
    }));
  }

  const chunkStatsByDoc = new Map(
    chunkAggregates.map((agg) => [
      agg.documentId,
      {
        chunkCount: agg._count.id,
        totalTokens: agg._sum.estimatedTokens ?? 0,
      },
    ])
  );

  // For embedded view, filter out documents with zero embedded chunks
  const filteredDocuments = embeddedOnly
    ? documents.filter((d) => (chunkStatsByDoc.get(d.id)?.chunkCount ?? 0) > 0)
    : documents;

  // Compute stats
  const totalChunks = chunkAggregates.reduce((sum, agg) => sum + agg._count.id, 0);
  const totalTokens = chunkAggregates.reduce(
    (sum, agg) => sum + (agg._sum.estimatedTokens ?? 0),
    0
  );
  const completedCount = filteredDocuments.filter((d) => d.status === 'ready').length;

  const stats: GraphStats = {
    documentCount: filteredDocuments.length,
    completedCount,
    chunkCount: totalChunks,
    totalTokens,
  };

  const showChunks = totalChunks <= CHUNK_NODE_THRESHOLD;

  // Build nodes
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  // Central KB node
  nodes.push({
    id: 'kb',
    name: 'Knowledge Base',
    type: 'kb',
    value: 60,
    category: 0,
    metadata: {
      documents: filteredDocuments.length,
      chunks: totalChunks,
      totalTokens,
      scope: scope ?? 'all',
      view,
    },
  });

  // Document nodes
  for (const doc of filteredDocuments) {
    const docStats = chunkStatsByDoc.get(doc.id);
    const chunkCount = docStats?.chunkCount ?? doc._count.chunks;
    const symbolSize = Math.min(20 + chunkCount * 2, 50);

    nodes.push({
      id: doc.id,
      name: doc.name,
      type: 'document',
      value: symbolSize,
      status: doc.status,
      category: documentCategoryIndex(doc.status),
      metadata: {
        fileName: doc.fileName,
        status: doc.status,
        scope: doc.scope,
        chunkCount,
        totalTokens: docStats?.totalTokens ?? 0,
        createdAt: doc.createdAt,
        ...(doc.errorMessage ? { errorMessage: doc.errorMessage } : {}),
      },
    });

    links.push({
      source: 'kb',
      target: doc.id,
      label: chunkCount > 0 ? `contains (${chunkCount} chunks)` : 'contains',
    });
  }

  // Chunk nodes (only if below threshold)
  if (showChunks) {
    const filteredDocIds = filteredDocuments.map((d) => d.id);

    let chunks: Array<{
      id: string;
      chunkKey: string;
      documentId: string;
      chunkType: string;
      patternName: string | null;
      section: string | null;
      estimatedTokens: number | null;
      content: string;
      embeddingModel: string | null;
      embeddingProvider: string | null;
      embeddedAt: Date | null;
    }>;

    if (embeddedOnly) {
      chunks = await prisma.$queryRaw<typeof chunks>`
        SELECT id, "chunkKey", "documentId", "chunkType", "patternName", section,
               "estimatedTokens", content, "embeddingModel", "embeddingProvider", "embeddedAt"
         FROM ai_knowledge_chunk
         WHERE "documentId" = ANY(${filteredDocIds}::text[]) AND embedding IS NOT NULL
      `;
    } else {
      chunks = await prisma.aiKnowledgeChunk.findMany({
        where: { documentId: { in: filteredDocIds } },
        select: {
          id: true,
          chunkKey: true,
          documentId: true,
          chunkType: true,
          patternName: true,
          section: true,
          estimatedTokens: true,
          content: true,
          embeddingModel: true,
          embeddingProvider: true,
          embeddedAt: true,
        },
      });
    }

    for (const chunk of chunks) {
      const tokens = chunk.estimatedTokens ?? 0;
      const symbolSize = Math.min(8 + tokens / 100, 25);

      nodes.push({
        id: chunk.id,
        name: chunk.section ?? chunk.chunkType,
        type: 'chunk',
        value: symbolSize,
        category: 4,
        metadata: {
          chunkType: chunk.chunkType,
          patternName: chunk.patternName,
          section: chunk.section,
          estimatedTokens: tokens,
          contentPreview: chunk.content,
          ...(chunk.embeddingModel ? { embeddingModel: chunk.embeddingModel } : {}),
          ...(chunk.embeddingProvider ? { embeddingProvider: chunk.embeddingProvider } : {}),
          ...(chunk.embeddedAt ? { embeddedAt: chunk.embeddedAt } : {}),
        },
      });

      const edgeLabel =
        chunk.chunkType === 'pattern_overview'
          ? 'overview'
          : chunk.chunkType === 'pattern_section'
            ? `section${chunk.section ? `: ${chunk.section}` : ''}`
            : chunk.chunkType === 'glossary'
              ? 'glossary'
              : chunk.chunkType.replace(/_/g, ' ');
      links.push({ source: chunk.documentId, target: chunk.id, label: edgeLabel });
    }
  }

  log.info('Knowledge graph built', {
    nodeCount: nodes.length,
    linkCount: links.length,
    showChunks,
    scope: scope ?? 'all',
    view,
  });

  return successResponse({ nodes, links, categories: CATEGORIES, stats });
});
