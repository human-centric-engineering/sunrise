/**
 * Orchestration settings resolver
 *
 * Reads the singleton `AiOrchestrationSettings` row to resolve the
 * task → default-model mapping used by the chat handler and other
 * orchestration callers. Split out of `model-registry.ts` so that
 * `lib/validations/orchestration.ts` can import `validateTaskDefaults`
 * from the registry without dragging the Prisma client (and `pg`)
 * into any client component that happens to import the validations
 * module.
 *
 * The resolver is server-only by virtue of the `@/lib/db/client`
 * import — it must never be transitively reachable from a client
 * component.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { parseStoredDefaults } from '@/lib/orchestration/settings';
import { computeDefaultModelMap } from '@/lib/orchestration/llm/model-registry';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';

/**
 * In-memory TTL cache for the `AiOrchestrationSettings` singleton's
 * `defaultModels` map. Invalidated by `invalidateSettingsCache()` (called
 * from the PATCH route) and rebuilt lazily on the next lookup.
 */
const SETTINGS_CACHE_TTL_MS = 30_000;
interface SettingsCacheEntry {
  defaults: Record<TaskType, string>;
  fetchedAt: number;
}
let settingsCache: SettingsCacheEntry | null = null;

/** Clear the cached `defaultModels` map so the next lookup re-reads the singleton. */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/**
 * Resolve the default model id for a task category from the singleton
 * `AiOrchestrationSettings` row. Falls back to `computeDefaultModelMap()`
 * for any task the row doesn't specify (and for the empty/missing-row
 * case). Results are cached for 30s so chat handlers don't hit the DB
 * on every turn.
 */
export async function getDefaultModelForTask(task: TaskType): Promise<string> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.fetchedAt < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.defaults[task];
  }

  let stored: Record<string, string> = {};
  try {
    const row = await prisma.aiOrchestrationSettings.findUnique({ where: { slug: 'global' } });
    if (row) {
      stored = parseStoredDefaults(row.defaultModels);
    }
  } catch (err) {
    logger.warn('getDefaultModelForTask: singleton read failed, using computed defaults', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const computed = computeDefaultModelMap();
  const merged: Record<TaskType, string> = { ...computed };
  for (const key of TASK_TYPES) {
    const val = stored[key];
    if (typeof val === 'string' && val.length > 0) merged[key] = val;
  }

  settingsCache = { defaults: merged, fetchedAt: now };
  return merged[task];
}

/** Reset the resolver cache. Intended for tests only. */
export function __resetSettingsResolverForTests(): void {
  settingsCache = null;
}
