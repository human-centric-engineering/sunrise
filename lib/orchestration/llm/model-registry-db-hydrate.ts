/**
 * Model Registry — DB hydration coordinator.
 *
 * Pulls active `AiProviderModel` rows into the in-memory registry's
 * state map. Operator-curated models (e.g. an admin adds `gpt-5` to
 * the Model Matrix before OpenRouter has indexed it) live in the DB
 * but aren't in the registry's hardcoded fallback. Without this
 * hydration, `getModel('gpt-5')` returns undefined and the semantic
 * validator emits `UNKNOWN_MODEL_OVERRIDE` even though the agent_call
 * path (which resolves via `resolveAgentProviderAndModel`) finds it
 * fine.
 *
 * Why this lives in its own file: `model-registry.ts` is reachable
 * from client components via `lib/validations/orchestration.ts` (which
 * imports `validateTaskDefaults`). Reaching for Prisma from inside the
 * registry — even via `await import()` — pulls `pg` into the browser
 * bundle ("Module not found: Can't resolve 'dns'"). Keeping the DB
 * dependency in a separate module that's never reachable from client
 * code is the durable fix. **Do NOT import this file from a client
 * component or anything reachable from one.**
 *
 * Idempotent + throttled to one SELECT per `DB_HYDRATE_TTL_MS` per
 * process so a parallel-execution burst doesn't fan out N queries.
 * Soft fail: a DB hiccup logs at warn and leaves prior state in place.
 * Callers must NOT depend on this for correctness — a genuinely
 * missing model still surfaces as `UNKNOWN_MODEL_OVERRIDE` at
 * validation time, which is the clearer error than a runtime crash.
 *
 * Tenancy posture: global-config — AiProviderModel has no org
 * (lib/tenancy/process-state.ts).
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { dbModelToModelInfo } from '@/lib/orchestration/llm/db-model-adapter';
import { registerModels } from '@/lib/orchestration/llm/model-registry';

const DB_HYDRATE_TTL_MS = 60_000;
/**
 * After a failed SELECT, wait this long before trying again — once a hydrate
 * has landed. The hydrate runs ahead of every LLM call (`getProvider`), so
 * without it a degraded database would take one more failing query per call.
 * Before the first success every call retries: the matrix's models are
 * missing, not merely stale, so skipping would mis-price and reject them.
 */
const DB_HYDRATE_FAILURE_BACKOFF_MS = 10_000;
let dbHydratedAt = 0;
let dbFailedAt = 0;
let inflight: Promise<void> | null = null;

export async function hydrateFromDb(): Promise<void> {
  if (Date.now() - dbHydratedAt < DB_HYDRATE_TTL_MS) return;
  if (dbHydratedAt !== 0 && Date.now() - dbFailedAt < DB_HYDRATE_FAILURE_BACKOFF_MS) return;
  // Always awaited: the settings route and the semantic validator hydrate so a
  // model an operator has just added validates (#302).
  return inflight ?? startHydrate();
}

function startHydrate(): Promise<void> {
  inflight = (async () => {
    try {
      // Oldest first, so when two providers' rows share a model id the same
      // one becomes the bare-id entry on every hydrate.
      const rows = await prisma.aiProviderModel.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      registerModels(rows.map(dbModelToModelInfo));
      dbHydratedAt = Date.now();
    } catch (err) {
      dbFailedAt = Date.now();
      logger.warn('Model registry: hydrateFromDb failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Test-only reset of the throttle state. */
export function __resetForTests(): void {
  dbHydratedAt = 0;
  dbFailedAt = 0;
  inflight = null;
}
