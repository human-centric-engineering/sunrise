/**
 * Get Pattern Detail capability
 *
 * Exposes `lib/orchestration/knowledge/search.ts#getPatternDetail`.
 * Given a pattern number, returns every chunk (ordered by section) so
 * the LLM can reason over the whole pattern rather than the top-k
 * snippets the search capability returns.
 */

import { z } from 'zod';
import { getPatternDetail } from '@/lib/orchestration/knowledge/search';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';

const schema = z.object({
  pattern_number: z.number().int().min(1).max(999),
});

type Args = z.infer<typeof schema>;

interface Chunk {
  chunkId: string;
  chunkKey: string;
  section: string | null;
  content: string;
  estimatedTokens: number | null;
}

interface Data {
  patternNumber: number;
  patternName: string | null;
  totalTokens: number;
  chunks: Chunk[];
}

export class GetPatternDetailCapability extends BaseCapability<Args, Data> {
  readonly slug = 'get_pattern_detail';

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'get_pattern_detail',
    description:
      'Return every chunk and metadata for a single agentic pattern, ordered by section for logical reading.',
    parameters: {
      type: 'object',
      properties: {
        pattern_number: {
          type: 'integer',
          description: 'The pattern number (1–999).',
          minimum: 1,
          maximum: 999,
        },
      },
      required: ['pattern_number'],
    },
  };

  protected readonly schema = schema;

  async execute(args: Args, _context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const detail = await getPatternDetail(args.pattern_number);

    if (detail.chunks.length === 0) {
      return this.error(`Pattern ${args.pattern_number} not found`, 'not_found');
    }

    return this.success({
      patternNumber: args.pattern_number,
      patternName: detail.patternName,
      totalTokens: detail.totalTokens,
      chunks: detail.chunks.map((c) => ({
        chunkId: c.id,
        chunkKey: c.chunkKey,
        section: c.section,
        content: c.content,
        estimatedTokens: c.estimatedTokens,
      })),
    });
  }
}
