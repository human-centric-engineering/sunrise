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
