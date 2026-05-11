/**
 * Admin Orchestration — Live per-provider model listing
 *
 * GET /api/v1/admin/orchestration/providers/:id/models
 *
 * Loads the provider row, resolves the instance via `providerManager.getProvider`,
 * then calls `provider.listModels()` live. This is deliberately distinct
 * from `GET /orchestration/models` (which returns the aggregated registry
 * view across every provider): "what does *this* provider say it has"
 * vs. "what do we know about across the ecosystem".
 *
 * Returns 503 if `listModels` throws — the provider is unreachable but
 * the route itself is fine.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getProvider, isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { inferCapability } from '@/lib/orchestration/llm/capability-inference';
import { refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { TASK_TYPES, type TaskType } from '@/types/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid provider id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const row = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(`Provider ${id} not found`);

  if (!row.isLocal && !isApiKeyEnvVarSet(row.apiKeyEnvVar)) {
    return errorResponse(`Provider "${row.slug}" has no API key configured`, {
      code: 'API_KEY_MISSING',
      status: 422,
    });
  }

  try {
    // Pull the OpenRouter catalogue so that the per-model enrichment
    // inside provider.listModels() returns live context + pricing
    // instead of the static fallback's zeros for any model not in the
    // small built-in map. Idempotent and 24h-cached, fails silently —
    // OpenRouter being unreachable just preserves the prior cache.
    // Skipped for local providers: their models aren't in OpenRouter
    // and we'd rather not make a network call on a fully-local setup.
    if (!row.isLocal) {
      await refreshFromOpenRouter();
    }

    const provider = await getProvider(row.slug);
    const [liveModels, matrixRows, agentRows, settings] = await Promise.all([
      provider.listModels(),
      // LEFT JOIN — annotate live SDK output with our curated matrix.
      // Matrix rows are the source of truth for capabilities + tier
      // when present; for everything else we fall back to inference.
      prisma.aiProviderModel.findMany({
        where: { providerSlug: row.slug, isActive: true },
        select: {
          id: true,
          modelId: true,
          capabilities: true,
          tierRole: true,
        },
      }),
      // LEFT JOIN — list active agents bound to this provider so the
      // panel can surface "which agents use this model". Match is by
      // (provider, model) string pair since AiAgent stores both as
      // free-text rather than FKs.
      prisma.aiAgent.findMany({
        where: { provider: row.slug, isActive: true },
        select: { id: true, name: true, slug: true, model: true },
        orderBy: { name: 'asc' },
      }),
      // Resolve effective default-models map so each row can advertise
      // any TaskType slot it currently fills (routing/chat/reasoning/
      // embeddings). Agents with empty provider/model fall back to
      // these defaults — surface them in the panel so an operator can
      // see at a glance which models the runtime relies on, separately
      // from the agents that name the model directly.
      getOrchestrationSettings(),
    ]);

    const matrixByModelId = new Map(matrixRows.map((m) => [m.modelId, m]));
    const agentsByModelId = new Map<string, Array<{ id: string; name: string; slug: string }>>();
    for (const a of agentRows) {
      if (!a.model) continue;
      const list = agentsByModelId.get(a.model) ?? [];
      list.push({ id: a.id, name: a.name, slug: a.slug });
      agentsByModelId.set(a.model, list);
    }

    // Reverse index modelId → task slots it fills. Empty strings — the
    // registry's `embeddings` fallback when no operator override is
    // saved — are dropped so the panel doesn't claim every row is the
    // embeddings default.
    const defaultRolesByModelId = new Map<string, TaskType[]>();
    for (const task of TASK_TYPES) {
      const modelId = settings.defaultModels[task];
      if (!modelId) continue;
      const list = defaultRolesByModelId.get(modelId) ?? [];
      list.push(task);
      defaultRolesByModelId.set(modelId, list);
    }

    const enriched = liveModels.map((m) => {
      const matrix = matrixByModelId.get(m.id);
      // Matrix capabilities take precedence; fall back to inference
      // so unmatched models still get a meaningful badge + a routed
      // Test button rather than a generic chat call that 404s.
      const capabilities = matrix?.capabilities ?? [inferCapability(row.slug, m.id)];
      return {
        ...m,
        inMatrix: Boolean(matrix),
        matrixId: matrix?.id ?? null,
        capabilities,
        tierRole: matrix?.tierRole ?? null,
        agents: agentsByModelId.get(m.id) ?? [],
        // Task slots this model serves as the effective system
        // default. Distinct from `agents` — the former tracks direct
        // assignment, this tracks inheritance via the system defaults.
        defaultFor: defaultRolesByModelId.get(m.id) ?? [],
      };
    });

    log.info('Provider models listed', {
      providerId: id,
      slug: row.slug,
      modelCount: enriched.length,
      matrixMatched: enriched.filter((m) => m.inMatrix).length,
      modelsInUse: enriched.filter((m) => m.agents.length > 0).length,
      modelsServingDefaults: enriched.filter((m) => m.defaultFor.length > 0).length,
    });
    return successResponse({ providerId: id, slug: row.slug, models: enriched });
  } catch (err) {
    // Raw SDK error is deliberately withheld from the client — in a
    // blind-SSRF context it would act as an exfiltration oracle about
    // the baseUrl target. Log it server-side, return a generic message.
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Provider listModels failed', { providerId: id, slug: row.slug, error: message });
    return errorResponse(`Provider "${row.slug}" is unavailable`, {
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
    });
  }
});
