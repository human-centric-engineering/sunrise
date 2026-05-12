/**
 * DB model adapter
 *
 * Bridges the persisted `AiProviderModel` rows (operator-curated, shown
 * on the Provider Models matrix) to the `ModelInfo` shape consumed by
 * the orchestration registry and the agent-form Model dropdown.
 *
 * Why this exists: the in-memory model registry is sync, fed from a
 * static fallback map plus the OpenRouter pricing fetch. Operators
 * routinely add newer models (e.g. `gpt-5`) to the matrix that the
 * static map doesn't know about and OpenRouter hasn't published yet.
 * Without this adapter, those rows show up in the matrix but never
 * reach the form's Model dropdown — the form silently lists a stale
 * subset.
 *
 * The merge happens at the `/api/v1/admin/orchestration/models` route
 * boundary so the sync registry stays free of DB reads (the chat
 * runtime still calls `getAvailableModels()` without a round-trip).
 */

import type { AiProviderModel } from '@/types/prisma';
import type { ModelInfo, ModelTier } from '@/lib/orchestration/llm/types';

/**
 * Map the DB row's `tierRole` (admin matrix vocabulary) onto the
 * `ModelTier` enum the registry uses for filtering / display.
 *
 * Best-effort: `tierRole` is a richer classification, so we collapse
 * down. Mostly used by the agent form's inline tier label and the
 * Costs / Settings tier filters, where exact alignment doesn't matter.
 */
export function mapTierRoleToTier(tierRole: string): ModelTier {
  switch (tierRole) {
    case 'thinking':
      return 'frontier';
    case 'local_sovereign':
      return 'local';
    case 'infrastructure':
      return 'budget';
    case 'worker':
    case 'control_plane':
    case 'embedding':
    default:
      return 'mid';
  }
}

/**
 * Translate the matrix's `contextLength` enum into an approximate
 * `maxContext` token count. The registry exposes a numeric ceiling so
 * tier filters and cost estimates can work; the matrix only stores a
 * coarse label, so we pick a representative midpoint per bucket.
 */
function mapContextLengthToMax(contextLength: string): number {
  switch (contextLength) {
    case 'very_high':
      return 1_000_000;
    case 'high':
      return 200_000;
    case 'medium':
      return 32_000;
    case 'n_a':
    default:
      return 0;
  }
}

/** Convert a single DB row into a `ModelInfo`. Always marks `available: true`. */
export function dbModelToModelInfo(row: AiProviderModel): ModelInfo {
  const cost = row.costPerMillionTokens ?? 0;
  return {
    id: row.modelId,
    name: row.name,
    provider: row.providerSlug,
    tier: mapTierRoleToTier(row.tierRole),
    inputCostPerMillion: cost,
    outputCostPerMillion: cost,
    maxContext: mapContextLengthToMax(row.contextLength),
    supportsTools: row.toolUse !== 'none',
    available: true,
    // Surface capabilities so the agent form can pre-emptively disable
    // toggles when the selected model lacks `'vision'` / `'documents'`.
    // The capability gate is still the authoritative runtime check;
    // this prop is for UX-level constraint only.
    capabilities: row.capabilities,
  };
}

/**
 * Merge the operator-curated DB rows on top of the registry view.
 * Conflicts on `(provider, modelId)` resolve to the DB row — the
 * matrix is the source of truth for "is this model usable right now",
 * the registry is the fallback catalogue.
 */
export function mergeDbModelsWithRegistry(
  registryModels: ModelInfo[],
  dbModels: AiProviderModel[]
): ModelInfo[] {
  const dbBySlug = new Map<string, ModelInfo>();
  for (const row of dbModels) {
    dbBySlug.set(`${row.providerSlug}::${row.modelId}`, dbModelToModelInfo(row));
  }

  const merged: ModelInfo[] = [];
  const seen = new Set<string>();
  for (const m of registryModels) {
    const key = `${m.provider}::${m.id}`;
    const override = dbBySlug.get(key);
    merged.push(override ?? m);
    seen.add(key);
  }

  // Append DB-only rows the registry never heard of (e.g. gpt-5).
  for (const [key, m] of dbBySlug) {
    if (!seen.has(key)) merged.push(m);
  }

  return merged;
}
