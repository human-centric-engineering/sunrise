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
}

interface ModelsResponse {
  models: Array<{ provider: string; id: string; tier?: string }>;
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
