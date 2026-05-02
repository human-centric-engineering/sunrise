/**
 * Search Knowledge Base capability
 *
 * Exposes `lib/orchestration/knowledge/search.ts#searchKnowledge` as a
 * callable tool for agents. The LLM hands us a natural-language query
 * (and optionally a pattern number filter) and we return the top
 * matches with their similarity scores so it can cite them.
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { searchKnowledge, type SearchFilters } from '@/lib/orchestration/knowledge/search';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const DEFAULT_LIMIT = 10;
const DEFAULT_THRESHOLD = 0.7;

const schema = z.object({
  query: z.string().min(1).max(500),
  pattern_number: z.number().int().min(1).max(999).optional(),
  document_id: z.string().uuid().optional(),
});

type Args = z.infer<typeof schema>;

interface ResultItem {
  chunkId: string;
  documentId: string;
  documentName: string | null;
  content: string;
  patternNumber: number | null;
  patternName: string | null;
  section: string | null;
  similarity: number;
  /** Hybrid mode only: (1 − cosine_distance) component before weighting. */
  vectorScore?: number;
  /** Hybrid mode only: ts_rank_cd BM25-flavoured component before weighting. */
  keywordScore?: number;
  /** Hybrid mode only: blended `vectorWeight × vectorScore + bm25Weight × keywordScore`. */
  finalScore?: number;
}

interface Data {
  results: ResultItem[];
}

export class SearchKnowledgeCapability extends BaseCapability<Args, Data> {
  readonly slug = 'search_knowledge_base';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'search_knowledge_base',
    description:
      'Semantic search over the knowledge base. Returns the top matching chunks ranked by cosine similarity (with optional BM25-flavoured keyword scoring in hybrid mode). Each result carries a numeric `marker` field — when you ground a claim in a result, cite it inline using that marker in square brackets, e.g. "the deposit must be protected within 30 days [1]". A separate citations panel renders the source for each marker, so the user can verify the claim.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language search query.',
          minLength: 1,
          maxLength: 500,
        },
        pattern_number: {
          type: 'integer',
          description: 'Optional filter to a single pattern number (1–999).',
          minimum: 1,
          maximum: 999,
        },
        document_id: {
          type: 'string',
          format: 'uuid',
          description:
            'Optional filter to search within a single uploaded document. Use when the user wants results scoped to a specific file they uploaded.',
        },
      },
      required: ['query'],
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    // Load agent's knowledge category restrictions
    const agent = await prisma.aiAgent.findUnique({
      where: { id: context.agentId },
      select: { knowledgeCategories: true },
    });
    const agentCategories = agent?.knowledgeCategories ?? [];

    // Build filters combining user args and agent-level category scoping
    const filters: SearchFilters = {};
    if (args.pattern_number !== undefined) {
      filters.patternNumber = args.pattern_number;
    }
    if (args.document_id !== undefined) {
      filters.documentId = args.document_id;
    }
    if (agentCategories.length > 0) {
      filters.categories = agentCategories;
    }

    const results = await searchKnowledge(
      args.query,
      Object.keys(filters).length > 0 ? filters : undefined,
      DEFAULT_LIMIT,
      DEFAULT_THRESHOLD
    );

    return this.success({
      results: results.map((r) => ({
        chunkId: r.chunk.id,
        documentId: r.chunk.documentId,
        documentName: r.documentName ?? null,
        content: r.chunk.content,
        patternNumber: r.chunk.patternNumber,
        patternName: r.chunk.patternName,
        section: r.chunk.section,
        similarity: r.similarity,
        ...(r.vectorScore !== undefined ? { vectorScore: r.vectorScore } : {}),
        ...(r.keywordScore !== undefined ? { keywordScore: r.keywordScore } : {}),
        ...(r.finalScore !== undefined ? { finalScore: r.finalScore } : {}),
      })),
    });
  }
}
