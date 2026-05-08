/**
 * Admin Orchestration — Provider Env-Var Detection
 *
 * GET /api/v1/admin/orchestration/providers/detect
 *
 * Scans `process.env` for known LLM provider API keys and reports which
 * ones are present, alongside the suggested provider config (slug,
 * baseUrl, providerType, recommended chat / embedding model). The
 * setup wizard uses this to render "We detected X — configure now?"
 * cards on a fresh install.
 *
 * Each detection row is also flagged `alreadyConfigured: true` if a
 * provider with the matching `providerType` already exists, so the
 * wizard hides duplicates.
 *
 * Security: returns booleans only — env-var *values* are never exposed
 * to the browser, never logged, never returned in the response body.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import {
  KNOWN_PROVIDERS,
  detectApiKeyEnvVar,
  type KnownProvider,
} from '@/lib/orchestration/llm/known-providers';

interface KnownProviderDetection {
  slug: string;
  name: string;
  providerType: KnownProvider['providerType'];
  defaultBaseUrl: string | null;
  /** Env-var name found in `process.env` (the *name*, never the value). */
  apiKeyEnvVar: string | null;
  apiKeyPresent: boolean;
  /** True if a provider row with this `providerType` already exists. */
  alreadyConfigured: boolean;
  isLocal: boolean;
  suggestedDefaultChatModel: string | null;
  suggestedRoutingModel: string | null;
  suggestedReasoningModel: string | null;
  suggestedEmbeddingModel: string | null;
}

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);

  // Dedup by slug only. `providerType` is too coarse — half the
  // catalogue shares `openai-compatible`, so a single OpenAI row would
  // otherwise mark Voyage, Google, Mistral, etc. as already configured.
  const existingSlugs = new Set(
    (
      await prisma.aiProviderConfig.findMany({
        select: { slug: true },
      })
    ).map((row) => row.slug)
  );

  const detected: KnownProviderDetection[] = KNOWN_PROVIDERS.map((p) => {
    const apiKeyEnvVar = p.isLocal ? null : detectApiKeyEnvVar(p);
    return {
      slug: p.slug,
      name: p.name,
      providerType: p.providerType,
      defaultBaseUrl: p.defaultBaseUrl,
      apiKeyEnvVar,
      apiKeyPresent: apiKeyEnvVar !== null,
      alreadyConfigured: existingSlugs.has(p.slug),
      isLocal: p.isLocal,
      suggestedDefaultChatModel: p.suggestedDefaultChatModel,
      suggestedRoutingModel: p.suggestedRoutingModel,
      suggestedReasoningModel: p.suggestedReasoningModel,
      suggestedEmbeddingModel: p.suggestedEmbeddingModel,
    };
  });

  log.info('Provider detection scan', {
    total: detected.length,
    keysSet: detected.filter((d) => d.apiKeyPresent).length,
    alreadyConfigured: detected.filter((d) => d.alreadyConfigured).length,
  });

  return successResponse({ detected });
});
