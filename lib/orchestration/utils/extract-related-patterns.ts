import type { AiKnowledgeChunk } from '@/types/orchestration';

export interface RelatedPattern {
  number: number;
  name: string | null;
}

/**
 * Extract cross-referenced pattern numbers from chunk content.
 *
 * Matches forms like "Pattern 2", "Pattern #14", "Pattern 3 (Parallel)",
 * and "pattern #1 (Prompt Chaining)". Deduplicates and excludes the
 * current pattern.
 */
export function extractRelatedPatterns(
  chunks: AiKnowledgeChunk[],
  currentPatternNumber: number
): RelatedPattern[] {
  const seen = new Map<number, string | null>();
  const regex = /[Pp]attern\s*#?(\d+)(?:\s*\(([^)]+)\))?/g;

  for (const chunk of chunks) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(chunk.content)) !== null) {
      const num = parseInt(match[1], 10);
      if (num === currentPatternNumber || isNaN(num)) continue;
      // Keep the first name we find for each pattern number
      if (!seen.has(num)) {
        seen.set(num, match[2]?.trim() ?? null);
      }
    }
  }

  return Array.from(seen.entries())
    .map(([number, name]) => ({ number, name }))
    .sort((a, b) => a.number - b.number);
}
