/**
 * Admin Orchestration — Model discovery
 *
 * GET /api/v1/admin/orchestration/discovery/models?providerSlug=...
 *
 * Two-tier candidate discovery for the matrix-add flow. Fans out
 * across the vendor's own listModels() output (live SDK) and the
 * cached OpenRouter catalogue, then annotates each candidate with
 * matrix-presence + heuristic-derived suggestions for the discovery
 * dialog's review step.
 *
 * Layered tolerance:
 *
 *   - Both tiers run in parallel; either can fail without aborting
 *     the response. Vendor-only or OpenRouter-only is still useful
 *     (Anthropic only ships 3 hardcoded models from listModels — we
 *     need OpenRouter to surface the rest of the family).
 *   - Both fail → 503 PROVIDER_UNAVAILABLE.
 *
 * No writes happen here. The discovery dialog POSTs to
 * `/provider-models/bulk` to actually create rows.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getProvider, isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { inferCapability, type Capability } from '@/lib/orchestration/llm/capability-inference';
import { getModelsByProvider, refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import {
  deriveBestRole,
  deriveContextLength,
  deriveCostEfficiency,
  deriveLatency,
  deriveMatrixSlug,
  deriveReasoningDepth,
  deriveTierRole,
  deriveToolUse,
} from '@/lib/orchestration/llm/model-heuristics';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

const querySchema = z.object({
  providerSlug: z.string().min(1).max(64),
});

interface DiscoveryCandidate {
  modelId: string;
  name: string;
  sources: { vendor: boolean; openrouter: boolean };
  inMatrix: boolean;
  matrixId: string | null;
  inferredCapability: Capability;
  suggested: {
    capabilities: string[];
    tierRole: string;
    reasoningDepth: string;
    latency: string;
    costEfficiency: string;
    contextLength: string;
    toolUse: string;
    bestRole: string;
    inputCostPerMillion: number | null;
    outputCostPerMillion: number | null;
    maxContext: number | null;
    slug: string;
  };
}

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    providerSlug: url.searchParams.get('providerSlug'),
  });
  if (!parsed.success) {
    throw new ValidationError('Invalid query parameters', {
      providerSlug: parsed.error.issues.map((i) => i.message),
    });
  }
  const { providerSlug } = parsed.data;

  const providerRow = await prisma.aiProviderConfig.findUnique({
    where: { slug: providerSlug },
  });
  if (!providerRow || !providerRow.isActive) {
    return errorResponse(`Active provider "${providerSlug}" not found`, {
      code: 'NOT_FOUND',
      status: 404,
    });
  }

  // Both tiers run in parallel — keeps the route fast and lets us
  // fall back cleanly when either one fails.
  const vendorPromise = (async (): Promise<ModelInfo[] | null> => {
    if (!providerRow.isLocal && !isApiKeyEnvVarSet(providerRow.apiKeyEnvVar)) {
      // No API key — the vendor SDK can't be called. Skip without
      // failing the route so OpenRouter still has a chance.
      return null;
    }
    try {
      const provider = await getProvider(providerRow.slug);
      return await provider.listModels();
    } catch (err) {
      log.warn('Discovery: vendor listModels failed', {
        providerSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  })();

  const openrouterPromise = (async (): Promise<ModelInfo[] | null> => {
    try {
      await refreshFromOpenRouter();
      return getModelsByProvider(providerSlug);
    } catch (err) {
      log.warn('Discovery: OpenRouter refresh failed', {
        providerSlug,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  })();

  const [vendorModels, openrouterModels] = await Promise.all([vendorPromise, openrouterPromise]);

  if (vendorModels === null && openrouterModels === null) {
    return errorResponse('Could not discover models from any source', {
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
    });
  }

  // Merge by canonical model id. The vendor's listModels uses the
  // canonical id (e.g. 'gpt-4o'); OpenRouter's `provider` field plus
  // canonical `id` give the same result after `getModelsByProvider`.
  // Tracking source flags lets the dialog show vendor / openrouter
  // dots so operators can spot OpenRouter-only suggestions.
  //
  // The `name` field is intentionally set to the canonical model id —
  // OpenRouter's prefixed display names ("OpenAI: GPT-4o") only fire
  // for chat-tier models and create a presentation split with
  // vendor-only entries (image / audio / embedding) that fall back to
  // the bare id. Using the id as the label everywhere keeps the
  // dialog consistent; OpenRouter still contributes pricing, context
  // window, and capability flags via `live` / `or`.
  const merged = new Map<
    string,
    { name: string; vendor: boolean; openrouter: boolean; live?: ModelInfo; or?: ModelInfo }
  >();

  for (const m of vendorModels ?? []) {
    merged.set(m.id, { name: m.id, vendor: true, openrouter: false, live: m });
  }
  for (const m of openrouterModels ?? []) {
    const existing = merged.get(m.id);
    if (existing) {
      existing.openrouter = true;
      existing.or = m;
    } else {
      merged.set(m.id, { name: m.id, vendor: false, openrouter: true, or: m });
    }
  }

  // LEFT JOIN against the matrix — operators need to know what's
  // already in to avoid duplicate adds (which would silently
  // skip-duplicate at insert time anyway, but the UI should reflect
  // it up front).
  //
  // Filter to active rows only — matches `/providers/:id/models`
  // (Phase A). Inactive (soft-deleted) rows shouldn't block
  // re-add via discovery; they fall through and the bulk endpoint
  // surfaces them as `already_in_matrix_inactive` if the operator
  // tries to add one back, prompting reactivation instead of a
  // silent skip.
  const matrixRows = await prisma.aiProviderModel.findMany({
    where: { providerSlug, isActive: true },
    select: { id: true, modelId: true },
  });
  const matrixByModelId = new Map(matrixRows.map((r) => [r.modelId, r.id]));

  const candidates: DiscoveryCandidate[] = Array.from(merged.entries()).map(([modelId, agg]) => {
    // Prefer vendor pricing (more authoritative for the configured
    // provider) but fall back to OpenRouter when vendor is silent.
    const live = agg.live ?? agg.or ?? null;
    const inputCostPerMillion = live?.inputCostPerMillion ?? null;
    const outputCostPerMillion = live?.outputCostPerMillion ?? null;
    const maxContext = live?.maxContext ?? null;
    const supportsTools = live?.supportsTools ?? false;

    const cap = inferCapability(providerSlug, modelId);
    const reasoningDepth = deriveReasoningDepth(modelId, cap);
    const costEfficiency = deriveCostEfficiency(inputCostPerMillion);
    const latency = deriveLatency(modelId);
    const contextLength = deriveContextLength(maxContext);
    const tierRole = deriveTierRole({
      capability: cap,
      reasoningDepth,
      costEfficiency,
      latency,
      isLocal: providerRow.isLocal,
    });
    const toolUse = deriveToolUse({ supportsTools, capability: cap });
    const bestRole = deriveBestRole(tierRole, cap);
    const slug = deriveMatrixSlug(providerSlug, modelId);

    // Pass the inferred capability through verbatim. The matrix
    // accepts six capabilities (chat / reasoning / embedding / audio /
    // image / moderation); `unknown` is catalogue-only, so we emit
    // an empty array there and the dialog review step prompts the
    // operator to pick one before submit (the bulk endpoint's
    // `.min(1)` refinement will reject an empty array if they don't).
    const capabilities: string[] = cap === 'unknown' ? [] : [cap];

    return {
      modelId,
      name: agg.name,
      sources: { vendor: agg.vendor, openrouter: agg.openrouter },
      inMatrix: matrixByModelId.has(modelId),
      matrixId: matrixByModelId.get(modelId) ?? null,
      inferredCapability: cap,
      suggested: {
        capabilities,
        tierRole,
        reasoningDepth,
        latency,
        costEfficiency,
        contextLength,
        toolUse,
        bestRole,
        inputCostPerMillion: inputCostPerMillion === 0 ? null : inputCostPerMillion,
        outputCostPerMillion: outputCostPerMillion === 0 ? null : outputCostPerMillion,
        maxContext: maxContext === 0 ? null : maxContext,
        slug,
      },
    };
  });

  // Sort: matrix matches first, then by name (so the operator sees a
  // stable order across reloads).
  candidates.sort((a, b) => {
    if (a.inMatrix !== b.inMatrix) return a.inMatrix ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  log.info('Discovery models listed', {
    providerSlug,
    candidateCount: candidates.length,
    vendorAvailable: vendorModels !== null,
    openrouterAvailable: openrouterModels !== null,
    matrixMatched: candidates.filter((c) => c.inMatrix).length,
  });

  return successResponse({ providerSlug, candidates });
});
