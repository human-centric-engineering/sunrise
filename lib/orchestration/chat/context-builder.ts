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
 * Core supports only `contextType = "pattern"` as a built-in because
 * that's the only entity we have a clean loader for (`getPatternDetail`).
 * A fork can teach `buildContext` about additional types by registering
 * a loader via `registerContextContributor(type, loader)` — the fork-owned
 * `lib/app/context-contributors.ts` scaffold is auto-wired once before the
 * first lookup. Types with neither a built-in case nor a registered
 * contributor log a warn and return a benign placeholder so the LLM sees
 * "no context" rather than hallucinating. A contributor that throws is
 * caught and degraded to the same placeholder — a fork's loader error must
 * not fail the chat turn. Both placeholder paths are returned uncached so
 * they self-heal on the next turn.
 */

import { logger } from '@/lib/logging';
import { getPatternDetail } from '@/lib/orchestration/knowledge/search';
import { initAppContextContributors } from '@/lib/app/context-contributors';

const CONTEXT_CACHE_TTL_MS = 60 * 1000;
const CONTEXT_CACHE_MAX_SIZE = 500;

interface CacheEntry {
  value: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(type: string, id: string): string {
  return `${type}:${id}`;
}

/**
 * A prompt-context loader keyed by `contextType`. Returns the raw body
 * string to be framed as `LOCKED CONTEXT`; `buildContext` handles caching
 * and framing. Registered via `registerContextContributor`.
 */
type ContextContributor = (id: string) => Promise<string>;

const contributors = new Map<string, ContextContributor>();

/** Whether the auto-wired app contributor init (`lib/app/context-contributors.ts`) has run. */
let appInited = false;

/**
 * Register a prompt-context loader for a given `contextType`. Lets a fork
 * inject its own `LOCKED CONTEXT` block per turn without editing the core
 * `buildContext` switch. Idempotent by type: re-registering the same type
 * replaces the prior loader (mirrors the capability registry's per-slug
 * `register`). A built-in case (e.g. `"pattern"`) always takes precedence.
 *
 * This is the seam that lets a fork add context types without patching
 * core. Call it at module-import time (e.g. from
 * `lib/app/context-contributors.ts`), before the first dispatch.
 *
 * @see .context/orchestration/chat.md — the app-author guide
 */
export function registerContextContributor(type: string, loader: ContextContributor): void {
  contributors.set(type, loader);
}

/**
 * Run the fork's auto-wired contributor init exactly once, lazily, before
 * the first lookup. Mirrors how `registerBuiltInCapabilities` invokes
 * `initAppCapabilities()` — the fork accumulates registrations at import
 * time without a separate startup step.
 */
function ensureAppContributorsInited(): void {
  if (appInited) return;
  // Set the flag AFTER a successful init (matching `registerBuiltInCapabilities`
  // in the capability registry). If a fork's init throws, `appInited` stays
  // false so the next lookup retries rather than latching a half-registered
  // state for the process lifetime.
  initAppContextContributors();
  appInited = true;
}

/**
 * Test-only: drop all registered contributors and re-arm the one-shot app
 * init so each test starts from a known state. Not exported from the barrel.
 */
export function __resetContextContributorsForTests(): void {
  contributors.clear();
  appInited = false;
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

  ensureAppContributorsInited();

  let body: string;
  // Real results are cached for the TTL; benign "no context" placeholders are
  // not, so a contributor registered (or recovered) after a miss takes effect
  // on the next turn instead of being masked for up to 60 s.
  let cacheable = true;
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
      // No built-in case — fall back to a fork-registered contributor for
      // this type before giving up. Keeps core domain-agnostic while
      // letting a fork add context types without editing this switch.
      const contributor = contributors.get(type);
      if (contributor) {
        try {
          body = await contributor(id);
        } catch (err) {
          // A contributor that throws must not fail the whole chat turn.
          // Degrade to the benign placeholder (uncached, so a transient
          // loader error self-heals on the next turn).
          logger.error('buildContext: context contributor threw', {
            type,
            id,
            error: err instanceof Error ? err.message : String(err),
          });
          body = `No context loader for type '${type}'.`;
          cacheable = false;
        }
      } else {
        logger.warn('buildContext: unknown contextType', { type, id });
        body = `No context loader for type '${type}'.`;
        cacheable = false;
      }
    }
  }

  const framed = formatLockedContext(type, id, body);

  if (cacheable) {
    // Evict oldest entry if cache is at capacity
    if (cache.size >= CONTEXT_CACHE_MAX_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { value: framed, expiresAt: Date.now() + CONTEXT_CACHE_TTL_MS });
  }
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
