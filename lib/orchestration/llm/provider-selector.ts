/**
 * Provider Model Selection Heuristic
 *
 * Recommends models for a given task intent based on the provider
 * model matrix stored in `AiProviderModel` rows. Follows the
 * same cache-with-TTL pattern as `settings-resolver.ts`.
 *
 * Decision heuristic mapping:
 *   thinking       → Tier 1 "Thinking" (frontier reasoning)
 *   doing          → Tier 2 "Worker" (cheap, parallel)
 *   fast_looping   → Tier 3 "Infrastructure" (low-latency)
 *   high_reliability → Tier 4 "Control Plane" (aggregators)
 *   private        → Tier 5 "Local / Sovereign"
 *   embedding      → "Embedding" tier
 *
 * Platform-agnostic consumers should not import this file directly —
 * it depends on `@/lib/db/client` and is server-only.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type {
  TaskIntent,
  TierRole,
  RatingLevel,
  LatencyLevel,
  ToolUseLevel,
} from '@/types/orchestration';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const MODEL_CACHE_TTL_MS = 60_000;

interface CachedModel {
  id: string;
  slug: string;
  providerSlug: string;
  modelId: string;
  name: string;
  capabilities: string[];
  tierRole: TierRole;
  reasoningDepth: RatingLevel;
  latency: LatencyLevel;
  costEfficiency: RatingLevel;
  contextLength: string;
  toolUse: ToolUseLevel;
  bestRole: string;
  isActive: boolean;
  // Embedding-specific
  dimensions: number | null;
  schemaCompatible: boolean | null;
  costPerMillionTokens: number | null;
  hasFreeTier: boolean | null;
  local: boolean;
  quality: string | null;
}

interface ModelCacheEntry {
  models: CachedModel[];
  fetchedAt: number;
}

let modelCache: ModelCacheEntry | null = null;

/** Clear the cached models so the next call re-reads from the DB. */
export function invalidateModelCache(): void {
  modelCache = null;
}

/** Reset cache — for tests only. */
export function __resetModelCacheForTests(): void {
  modelCache = null;
}

// ---------------------------------------------------------------------------
// Core heuristic
// ---------------------------------------------------------------------------

/** A scored model recommendation. */
export interface ModelRecommendation {
  slug: string;
  providerSlug: string;
  modelId: string;
  name: string;
  tierRole: TierRole;
  bestRole: string;
  score: number;
  reason: string;
}

/** Options for `recommendModels`. */
export interface RecommendOptions {
  /** Max results to return (default: 5). */
  limit?: number;
  /** Include inactive models (default: false). */
  includeInactive?: boolean;
}

/** Map each intent to its preferred tier role. */
const INTENT_TO_TIER: Record<TaskIntent, TierRole> = {
  thinking: 'thinking',
  doing: 'worker',
  fast_looping: 'infrastructure',
  high_reliability: 'control_plane',
  private: 'local_sovereign',
  embedding: 'embedding',
};

/** Numeric score for rating levels (higher = better). */
const RATING_SCORE: Record<string, number> = {
  very_high: 3,
  very_fast: 3,
  high: 2,
  fast: 2,
  strong: 2,
  medium: 1,
  moderate: 1,
  none: 0,
  n_a: 0,
};

/**
 * Which secondary dimension matters most for each non-embedding intent.
 * Embedding intent uses a separate scoring path (see `recommendModels`).
 */
const INTENT_SECONDARY: Record<Exclude<TaskIntent, 'embedding'>, keyof CachedModel> = {
  thinking: 'reasoningDepth',
  doing: 'costEfficiency',
  fast_looping: 'latency',
  high_reliability: 'toolUse',
  private: 'costEfficiency',
};

/**
 * Recommend models for a given task intent.
 *
 * Reads active `AiProviderModel` rows (cached 60s), scores each
 * against the intent, and returns sorted recommendations.
 * For non-embedding intents, embedding-only models are excluded.
 */
export async function recommendModels(
  intent: TaskIntent,
  options: RecommendOptions = {}
): Promise<ModelRecommendation[]> {
  const { limit = 5, includeInactive = false } = options;
  const models = await loadModels();

  const preferredTier = INTENT_TO_TIER[intent];
  const isEmbeddingIntent = intent === 'embedding';

  const scored: ModelRecommendation[] = [];

  for (const model of models) {
    if (!includeInactive && !model.isActive) continue;

    // For non-embedding intents, skip embedding-only models
    if (
      !isEmbeddingIntent &&
      model.capabilities.length === 1 &&
      model.capabilities[0] === 'embedding'
    )
      continue;
    // For embedding intent, only include models with embedding capability
    if (isEmbeddingIntent && !model.capabilities.includes('embedding')) continue;

    let score: number;
    let reason: string;

    if (isEmbeddingIntent) {
      // Embedding-specific scoring
      score = 0;
      if (model.schemaCompatible) score += 40;
      score += (RATING_SCORE[model.costEfficiency] ?? 0) * 7;
      if (model.quality === 'high') score += 20;
      else if (model.quality === 'medium') score += 10;
      if (model.hasFreeTier) score += 10;
      if (model.local) score += 5;

      const parts: string[] = [];
      if (model.schemaCompatible) parts.push('schema-compatible');
      if (model.quality) parts.push(`${model.quality} quality`);
      if (model.hasFreeTier) parts.push('free tier');
      reason = parts.join(', ') || 'Embedding model';
    } else {
      const secondaryKey = INTENT_SECONDARY[intent];
      const tierMatch = model.tierRole === preferredTier;
      const primaryScore = tierMatch ? 60 : 0;
      const secondaryValue = String(model[secondaryKey]);
      const secondaryScore = (RATING_SCORE[secondaryValue] ?? 0) * 10;
      score = primaryScore + secondaryScore;

      reason = tierMatch
        ? `${tierLabel(preferredTier)} model with ${formatRating(secondaryValue)} ${formatKey(String(secondaryKey))}`
        : `Non-primary tier (${tierLabel(model.tierRole)}) with ${formatRating(secondaryValue)} ${formatKey(String(secondaryKey))}`;
    }

    scored.push({
      slug: model.slug,
      providerSlug: model.providerSlug,
      modelId: model.modelId,
      name: model.name,
      tierRole: model.tierRole,
      bestRole: model.bestRole,
      score,
      reason,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadModels(): Promise<CachedModel[]> {
  const now = Date.now();
  if (modelCache && now - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return modelCache.models;
  }

  try {
    const rows = await prisma.aiProviderModel.findMany({
      select: {
        id: true,
        slug: true,
        providerSlug: true,
        modelId: true,
        name: true,
        capabilities: true,
        tierRole: true,
        reasoningDepth: true,
        latency: true,
        costEfficiency: true,
        contextLength: true,
        toolUse: true,
        bestRole: true,
        isActive: true,
        dimensions: true,
        schemaCompatible: true,
        costPerMillionTokens: true,
        hasFreeTier: true,
        local: true,
        quality: true,
      },
    });

    const models = rows as CachedModel[];
    modelCache = { models, fetchedAt: now };
    return models;
  } catch (err) {
    logger.warn('Provider model cache load failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return modelCache?.models ?? [];
  }
}

function tierLabel(tier: TierRole): string {
  const labels: Record<TierRole, string> = {
    thinking: 'Thinking',
    worker: 'Worker',
    infrastructure: 'Infrastructure',
    control_plane: 'Control Plane',
    local_sovereign: 'Local/Sovereign',
    embedding: 'Embedding',
  };
  return labels[tier] ?? tier;
}

function formatRating(value: string): string {
  return value.replace(/_/g, ' ');
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .toLowerCase()
    .trim();
}
