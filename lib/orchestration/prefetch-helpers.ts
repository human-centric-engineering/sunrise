/**
 * Shared server-side prefetch helpers for orchestration pages.
 *
 * These fetch the provider list and model registry so form components
 * can hydrate without a loading flicker. Both are null-safe — on failure
 * the form falls back to free-text inputs with a warning banner.
 */

import { API } from '@/lib/api/endpoints';
import { parseApiResponse, serverFetch } from '@/lib/api/server-fetch';
import { logger } from '@/lib/logging';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { getDefaultModelForTaskOrNull } from '@/lib/orchestration/llm/settings-resolver';
import { prisma } from '@/lib/db/client';
import type { AiProviderConfig } from '@/types/prisma';

export interface ModelOption {
  /** Provider slug this model belongs to (`anthropic`, `openai`, etc.). */
  provider: string;
  /** Model identifier the provider exposes. */
  id: string;
  /** Tier label used for the dropdown hint (`frontier`, `mid`, `budget`). */
  tier?: string;
  /**
   * Capability strings carried on the matrix row (e.g. `'vision'`,
   * `'documents'`). Optional — populated only for DB-backed models
   * (registry-only entries are unknown). The agent form uses this to
   * disable image/document toggles when the selected model lacks the
   * capability. The runtime gate is still the authoritative check.
   */
  capabilities?: string[];
}

interface ModelsResponse {
  models: Array<{ provider: string; id: string; tier?: string; capabilities?: string[] }>;
}

export async function getProviders(): Promise<AiProviderConfig[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.PROVIDERS);
    if (!res.ok) return null;
    const body = await parseApiResponse<AiProviderConfig[]>(res);
    return body.success ? body.data : null;
  } catch (err) {
    logger.error('prefetch: provider fetch failed', err);
    return null;
  }
}

/**
 * Effective provider/model an agent will use at runtime.
 *
 * System-seeded agents (pattern-advisor, quiz-master, mcp-system,
 * model-auditor) ship with empty `provider` / `model` strings — the
 * chat runtime fills them in from the operator's first active provider
 * and the `AiOrchestrationSettings.defaultModels.chat` slot. The agent
 * form needs the same resolution to render a sensible initial selection
 * instead of an empty Select that falls back to a free-text input.
 *
 * Mirrors `resolveAgentProviderAndModel` but never throws:
 *  - if both are explicitly set, returns them as-is
 *  - if either is empty, looks up the first reachable provider /
 *    configured default model and returns whatever it finds (null on
 *    failure rather than throwing)
 *
 * The two `inheritedProvider` / `inheritedModel` flags let the form
 * mark the field as "currently inherited" so the user can see why the
 * value differs from the underlying DB row.
 */
export interface EffectiveAgentDefaults {
  provider: string;
  model: string;
  inheritedProvider: boolean;
  inheritedModel: boolean;
}

export async function getEffectiveAgentDefaults(agent: {
  provider: string;
  model: string;
}): Promise<EffectiveAgentDefaults> {
  const providerSet = agent.provider.length > 0;
  const modelSet = agent.model.length > 0;

  let provider = agent.provider;
  let model = agent.model;

  if (!providerSet) {
    try {
      const rows = await prisma.aiProviderConfig.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      const candidate = rows.find((r) => r.isLocal || isApiKeyEnvVarSet(r.apiKeyEnvVar));
      if (candidate) provider = candidate.slug;
    } catch (err) {
      logger.warn('prefetch: effective provider lookup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (!modelSet) {
    try {
      const defaultModel = await getDefaultModelForTaskOrNull('chat');
      if (defaultModel) model = defaultModel;
    } catch (err) {
      logger.warn('prefetch: effective model lookup failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    provider,
    model,
    inheritedProvider: !providerSet,
    inheritedModel: !modelSet,
  };
}

export async function getModels(): Promise<ModelOption[] | null> {
  try {
    const res = await serverFetch(API.ADMIN.ORCHESTRATION.MODELS);
    if (!res.ok) return null;
    const body = await parseApiResponse<ModelsResponse | ModelOption[]>(res);
    if (!body.success) return null;
    // The registry endpoint returns either `{ models: [...] }` or a flat
    // array depending on version — accept both shapes.
    const data = body.data;
    if (Array.isArray(data)) return data;
    if (data && 'models' in data && Array.isArray(data.models)) return data.models;
    return null;
  } catch (err) {
    logger.error('prefetch: model registry fetch failed', err);
    return null;
  }
}

/** Subset of an `AiProviderModel` row needed to shape into `ModelOption`. */
interface ProviderMatrixRow {
  modelId: string;
  providerSlug: string;
  capabilities?: string[] | null;
  /** Optional matrix metadata used purely for the dropdown's tier hint. */
  tierRole?: string | null;
  deploymentProfiles?: string[] | null;
}

interface ProviderMatrixListResponse {
  data?: unknown;
}

/**
 * Agent-form model dropdown source — restricted to the operator-curated
 * provider matrix, filtered to capabilities an agent can actually chat
 * through (`chat` OR `reasoning`), and only models with `isActive: true`.
 *
 * Why this exists separately from `getModels()`. The broader registry
 * view returns every model the static fallback or OpenRouter pricing
 * fetch knows about, even ones the operator has never configured. The
 * agent form is the wrong surface for that — selecting an unconfigured
 * model leads to a runtime "provider unavailable" error on the first
 * chat turn. The settings page's "Default Models" picker already uses
 * the matrix-only source; this helper aligns the agent form with the
 * same curation discipline.
 *
 * Two parallel fetches because the `/provider-models` endpoint's
 * `capability` query is a single value (`{ capabilities: { has: capability } }`).
 * Reasoning-only models (e.g. `o1-mini` if a deployment seeds it as
 * `capabilities: ['reasoning']`) wouldn't appear under `capability=chat`.
 * Merge by slug to deduplicate models tagged with both.
 *
 * On failure (network, non-2xx) returns `null` and the form falls back
 * to a free-text input with a warning banner — same posture as
 * `getModels()` for back-compat.
 */
export async function getAgentModels(): Promise<ModelOption[] | null> {
  try {
    const [chatRes, reasoningRes] = await Promise.all([
      serverFetch(
        `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=chat&isActive=true&limit=200`
      ),
      serverFetch(
        `${API.ADMIN.ORCHESTRATION.PROVIDER_MODELS}?capability=reasoning&isActive=true&limit=200`
      ),
    ]);
    if (!chatRes.ok && !reasoningRes.ok) return null;

    const chatRows = await readProviderMatrixRows(chatRes);
    const reasoningRows = await readProviderMatrixRows(reasoningRes);

    // Dedup by (provider, modelId) — a model tagged with BOTH chat and
    // reasoning capabilities shows up in both responses.
    const seen = new Set<string>();
    const merged: ModelOption[] = [];
    for (const row of [...chatRows, ...reasoningRows]) {
      const key = `${row.providerSlug}::${row.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        provider: row.providerSlug,
        id: row.modelId,
        // Tier hint mirrors `lib/orchestration/llm/db-model-adapter.ts`
        // `mapTierRoleToTier` — sovereign deployments collapse to
        // `local`; other tier roles keep their narrower mapping.
        tier: deriveTier(row.tierRole ?? null, row.deploymentProfiles ?? null),
        capabilities: row.capabilities ?? undefined,
      });
    }
    return merged;
  } catch (err) {
    logger.error('prefetch: agent matrix fetch failed', err);
    return null;
  }
}

async function readProviderMatrixRows(res: Response): Promise<ProviderMatrixRow[]> {
  if (!res.ok) return [];
  const body = await parseApiResponse<ProviderMatrixRow[] | ProviderMatrixListResponse>(res);
  if (!body.success) return [];
  const data = body.data;
  if (Array.isArray(data)) return data;
  // Defensive: some pagination shapes wrap rows in `{ data: [...] }`.
  // The current endpoint returns a flat array; this guard absorbs any
  // future shape drift without crashing the form.
  if (
    data &&
    typeof data === 'object' &&
    'data' in data &&
    Array.isArray((data as { data: unknown }).data)
  ) {
    return (data as { data: ProviderMatrixRow[] }).data;
  }
  return [];
}

function deriveTier(
  tierRole: string | null,
  deploymentProfiles: string[] | null
): string | undefined {
  if (deploymentProfiles?.includes('sovereign')) return 'local';
  switch (tierRole) {
    case 'thinking':
      return 'frontier';
    case 'infrastructure':
      return 'budget';
    case 'worker':
    case 'control_plane':
    case 'embedding':
      return 'mid';
    default:
      return undefined;
  }
}
