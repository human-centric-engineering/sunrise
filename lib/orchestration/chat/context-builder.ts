/**
 * Entity context builder
 *
 * Produces a stable `LOCKED CONTEXT` text block to splice into the
 * system prompt, given an entity `(contextType, contextId)` pair from
 * the chat request. Results are cached for 60 seconds per pair so
 * long-running conversations don't repeatedly re-fetch entities, and
 * the streaming handler calls `invalidateContext` after any capability
 * execution that could have mutated the underlying entity.
 *
 * Phase 2c supports only `contextType = "pattern"` because that's the
 * only entity we have a clean loader for (`getPatternDetail`). Unknown
 * types log a warn and return a benign placeholder so the LLM sees
 * "no context" rather than hallucinating.
 */

import { logger } from '@/lib/logging';
import { getPatternDetail } from '@/lib/orchestration/knowledge/search';

const CONTEXT_CACHE_TTL_MS = 60 * 1000;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * Load and frame context for the given entity, returning a string that
 * can be appended to the system prompt. Cached for 60 s per `(type, id)`.
 */
export async function buildContext(type: string, id: string): Promise<string> {
  const key = cacheKey(type, id);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value;
  }

  let body: string;
  switch (type) {
    case 'pattern': {
      const num = Number.parseInt(id, 10);
      if (!Number.isFinite(num)) {
        body = `Pattern id '${id}' is not numeric — no context available.`;
        break;
      }
      const detail = await getPatternDetail(num);
      if (detail.chunks.length === 0) {
        body = `Pattern #${num} not found in knowledge base.`;
      } else {
        const joined = detail.chunks
          .map((c) => `## ${c.section ?? 'section'}\n${c.content}`)
          .join('\n\n');
        body = `Pattern #${num}: ${detail.patternName ?? 'unnamed'}\n\n${joined}`;
      }
      break;
    }
    default: {
      logger.warn('buildContext: unknown contextType', { type, id });
      body = `No context loader for type '${type}'.`;
    }
  }

  const framed = formatLockedContext(type, id, body);
  cache.set(key, { value: framed, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
  return framed;
}

/** Drop the cache entry for a single entity. */
export function invalidateContext(type: string, id: string): void {
  cache.delete(cacheKey(type, id));
}

/** Wipe the entire context cache. Mainly for tests and admin hooks. */
export function clearContextCache(): void {
  cache.clear();
}

function formatLockedContext(type: string, id: string, body: string): string {
  return [
    '=== LOCKED CONTEXT ===',
    `type: ${type}`,
    `id: ${id}`,
    '',
    body,
    '=== END LOCKED CONTEXT ===',
  ].join('\n');
}
