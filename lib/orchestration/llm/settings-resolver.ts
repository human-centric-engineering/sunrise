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
 * **Strict mode:** unset slots throw `NoDefaultModelConfiguredError`
 * rather than silently falling back to the registry's "cheapest model"
 * pick. This makes "the system silently chose gpt-5-image-2 because it
 * happened to be the cheapest in the OpenRouter catalogue" a thing of
 * the past — operators have to deliberately save a default per task,
 * either via the setup wizard's one-click flow (which writes all four
 * slots) or via the Settings → Default models form.
 *
 * The resolver is server-only by virtue of the `@/lib/db/client`
 * import — it must never be transitively reachable from a client
 * component.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { parseStoredDefaults } from '@/lib/orchestration/settings';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';

/**
 * Thrown when a caller asks for a default model for a task and no
 * value has been saved to `AiOrchestrationSettings.defaultModels` for
 * that task. The runtime no longer silently picks a fallback — the
 * operator must save an explicit default first.
 *
 * Wraps `ProviderError` so existing chat-handler catch blocks
 * (`if (err instanceof ProviderError)`) surface it as a friendly
 * error event instead of crashing the request.
 */
export class NoDefaultModelConfiguredError extends ProviderError {
  public readonly task: TaskType;

  constructor(task: TaskType) {
    super(
      `No default model is configured for task "${task}". Save one in Admin → Settings → Default models.`,
      { code: 'no_default_model_configured', retriable: false }
    );
    this.name = 'NoDefaultModelConfiguredError';
    this.task = task;
  }
}

/**
 * In-memory TTL cache for the `AiOrchestrationSettings` singleton's
 * stored `defaultModels` subset. Invalidated by `invalidateSettingsCache()`
 * (called from the PATCH route) and rebuilt lazily on the next lookup.
 *
 * The cache holds the *raw stored* map only — empty slots stay empty
 * so callers see the strict "unset" state instead of a hydrated value.
 */
const SETTINGS_CACHE_TTL_MS = 30_000;
interface SettingsCacheEntry {
  stored: Partial<Record<TaskType, string>>;
  fetchedAt: number;
}
let settingsCache: SettingsCacheEntry | null = null;

/** Clear the cached `defaultModels` map so the next lookup re-reads the singleton. */
export function invalidateSettingsCache(): void {
  settingsCache = null;
}

/**
 * Resolve the default model id for a task category from the singleton
 * `AiOrchestrationSettings` row. Throws `NoDefaultModelConfiguredError`
 * when the slot is unset — the system never silently picks a fallback.
 *
 * Results are cached for 30s so chat handlers don't hit the DB on
 * every turn. Cache invalidates on PATCH /settings via
 * `invalidateSettingsCache()`.
 */
export async function getDefaultModelForTask(task: TaskType): Promise<string> {
  const stored = await loadStoredDefaults();
  const value = stored[task];
  if (typeof value !== 'string' || value.length === 0) {
    throw new NoDefaultModelConfiguredError(task);
  }
  return value;
}

/**
 * Like `getDefaultModelForTask` but returns `null` instead of
 * throwing. Useful for code paths that want to opportunistically read
 * the default but tolerate "not configured" without surfacing an
 * error to the user (e.g. UI hints, optional features).
 */
export async function getDefaultModelForTaskOrNull(task: TaskType): Promise<string | null> {
  const stored = await loadStoredDefaults();
  const value = stored[task];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function loadStoredDefaults(): Promise<Partial<Record<TaskType, string>>> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.fetchedAt < SETTINGS_CACHE_TTL_MS) {
    return settingsCache.stored;
  }

  const stored: Partial<Record<TaskType, string>> = {};
  try {
    const row = await prisma.aiOrchestrationSettings.findUnique({ where: { slug: 'global' } });
    if (row) {
      const raw = parseStoredDefaults(row.defaultModels);
      for (const key of TASK_TYPES) {
        const val = raw[key];
        if (typeof val === 'string' && val.length > 0) stored[key] = val;
      }
    }
  } catch (err) {
    // DB read failures are logged but don't seed any defaults — strict
    // mode means the next call still throws cleanly rather than serving
    // stale or computed values.
    logger.warn('getDefaultModelForTask: singleton read failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  settingsCache = { stored, fetchedAt: now };
  return stored;
}

/** Reset the resolver cache. Intended for tests only. */
export function __resetSettingsResolverForTests(): void {
  settingsCache = null;
}
