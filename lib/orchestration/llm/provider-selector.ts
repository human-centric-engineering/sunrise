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
import {
  TIER_ROLES,
  RATING_LEVELS,
  CONTEXT_LENGTH_LEVELS,
  LATENCY_LEVELS,
  TOOL_USE_LEVELS,
} from '@/types/orchestration';
import type {
  TaskIntent,
  TierRole,
  RatingLevel,
  ContextLengthLevel,
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
  contextLength: ContextLengthLevel;
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

/** @see invalidateModelCache — alias kept for test ergonomics. */
export const __resetModelCacheForTests = invalidateModelCache;

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
const RATING_SCORE: Record<RatingLevel | ContextLengthLevel | LatencyLevel | ToolUseLevel, number> =
  {
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
 * Embedding and private intents use separate scoring paths (see `recommendModels`).
 */
const INTENT_SECONDARY: Record<Exclude<TaskIntent, 'embedding' | 'private'>, keyof CachedModel> = {
  thinking: 'reasoningDepth',
  doing: 'costEfficiency',
  fast_looping: 'latency',
  high_reliability: 'toolUse',
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
      const effectiveQuality = model.quality ?? 'medium';
      if (effectiveQuality === 'high') score += 20;
      else if (effectiveQuality === 'medium') score += 10;
      if (model.hasFreeTier) score += 10;
      if (model.local) score += 5;

      const parts: string[] = [];
      if (model.schemaCompatible) parts.push('schema-compatible');
      parts.push(`${effectiveQuality} quality`);
      if (model.hasFreeTier) parts.push('free tier');
      reason = parts.join(', ');
    } else if (intent === 'private') {
      // Privacy-specific scoring — local/sovereign models strongly preferred
      const tierMatch = model.tierRole === preferredTier;
      score = tierMatch ? 60 : 0;
      if (model.local) score += 30;
      score += (RATING_SCORE[model.costEfficiency] ?? 0) * 5;
      // Add tertiary tiebreaker from context length
      score += (RATING_SCORE[model.contextLength] ?? 0) * 2;

      reason = tierMatch
        ? `Local/Sovereign model${model.local ? ' (self-hosted)' : ''}`
        : `Non-local tier (${tierLabel(model.tierRole)})${model.local ? ', self-hosted' : ''}`;
    } else {
      const secondaryKey = INTENT_SECONDARY[intent];
      const tierMatch = model.tierRole === preferredTier;
      const primaryScore = tierMatch ? 60 : 0;
      const secondaryValue = model[secondaryKey] as keyof typeof RATING_SCORE;
      const secondaryScore = (RATING_SCORE[secondaryValue] ?? 0) * 10;
      // Tertiary tiebreaker from context length
      const tertiaryScore = (RATING_SCORE[model.contextLength] ?? 0) * 2;
      score = primaryScore + secondaryScore + tertiaryScore;

      const secondaryLabel = formatRating(String(secondaryValue));
      const keyLabel = formatKey(String(secondaryKey));
      reason = tierMatch
        ? `${tierLabel(preferredTier)} model with ${secondaryLabel} ${keyLabel}`
        : `Non-primary tier (${tierLabel(model.tierRole)}) with ${secondaryLabel} ${keyLabel}`;
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

    // Validate enum fields at runtime — skip rows with invalid values
    // rather than silently producing incorrect scores.
    const tierSet = new Set<string>(TIER_ROLES);
    const ratingSet = new Set<string>(RATING_LEVELS);
    const contextSet = new Set<string>(CONTEXT_LENGTH_LEVELS);
    const latencySet = new Set<string>(LATENCY_LEVELS);
    const toolUseSet = new Set<string>(TOOL_USE_LEVELS);

    const models: CachedModel[] = [];
    for (const row of rows) {
      if (
        !tierSet.has(row.tierRole) ||
        !ratingSet.has(row.reasoningDepth) ||
        !latencySet.has(row.latency) ||
        !ratingSet.has(row.costEfficiency) ||
        !contextSet.has(row.contextLength) ||
        !toolUseSet.has(row.toolUse)
      ) {
        logger.warn('Skipping provider model with invalid enum value', {
          slug: row.slug,
          tierRole: row.tierRole,
        });
        continue;
      }
      models.push(row as CachedModel);
    }
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
