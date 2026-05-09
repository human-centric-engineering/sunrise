/**
 * Agent provider/model resolver
 *
 * Lets `AiAgent.provider` / `AiAgent.model` be empty strings, in which
 * case the values are looked up dynamically from the system defaults
 * (`AiOrchestrationSettings.defaultModels`) and the first active
 * `AiProviderConfig` row whose `apiKeyEnvVar` is set in `process.env`
 * (or whose row is `isLocal`).
 *
 * This is the seam that lets system-seeded agents (pattern-advisor,
 * quiz-master, mcp-system, model-auditor) start life provider-agnostic
 * — they ship with empty strings and inherit whatever the operator
 * configures via the setup wizard.
 *
 * Explicit values always win: a user-created agent that picked a
 * specific provider/model in the agent form keeps its choice. The
 * fallback only kicks in when both fields are empty strings.
 */

import type { AiAgent, AiProviderConfig } from '@/types/prisma';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { isApiKeyEnvVarSet } from '@/lib/orchestration/llm/provider-manager';
import { ProviderError } from '@/lib/orchestration/llm/provider';
import { getDefaultModelForTask } from '@/lib/orchestration/llm/settings-resolver';
import type { TaskType } from '@/types/orchestration';

/** Number of system fallbacks to attach when an agent has no explicit provider. */
const SYSTEM_FALLBACK_LIMIT = 3;

export interface ResolvedAgentBinding {
  providerSlug: string;
  model: string;
  fallbacks: string[];
}

/** Pick of the AiAgent fields the resolver actually reads. */
export type ResolvableAgent = Pick<AiAgent, 'provider' | 'model' | 'fallbackProviders'>;

/**
 * Thrown when an agent has no explicit provider/model and no active
 * provider in `AiProviderConfig` is reachable (no env key set, no
 * loopback row). The setup wizard's first-run gate should prevent
 * this in normal usage.
 */
export class NoProviderConfiguredError extends ProviderError {
  constructor(message = 'No provider is configured') {
    super(message, { code: 'no_provider_configured', retriable: false });
    this.name = 'NoProviderConfiguredError';
  }
}

/**
 * Resolve the provider slug, model id, and fallback list to use for a
 * chat turn or workflow step. Empty `agent.provider`/`agent.model` are
 * filled from system defaults; explicit values pass through unchanged.
 */
export async function resolveAgentProviderAndModel(
  agent: ResolvableAgent,
  task: TaskType = 'chat'
): Promise<ResolvedAgentBinding> {
  const providerSet = typeof agent.provider === 'string' && agent.provider.length > 0;
  const modelSet = typeof agent.model === 'string' && agent.model.length > 0;

  if (providerSet && modelSet) {
    return {
      providerSlug: agent.provider,
      model: agent.model,
      fallbacks: agent.fallbackProviders ?? [],
    };
  }

  const candidates = await pickActiveProviderCandidates();
  if (candidates.length === 0) {
    throw new NoProviderConfiguredError(
      'No active LLM provider is configured. Run the setup wizard to add one.'
    );
  }

  const providerSlug = providerSet ? agent.provider : candidates[0].slug;
  const model = modelSet ? agent.model : await getDefaultModelForTask(task);

  // System fallbacks: every other reachable candidate, capped. Skipped
  // if the agent already has an explicit fallback list.
  const explicitFallbacks = agent.fallbackProviders ?? [];
  const fallbacks =
    explicitFallbacks.length > 0
      ? explicitFallbacks
      : candidates
          .map((c) => c.slug)
          .filter((slug) => slug !== providerSlug)
          .slice(0, SYSTEM_FALLBACK_LIMIT);

  logger.debug('resolveAgentProviderAndModel: filled empty agent binding', {
    agentProvider: agent.provider,
    agentModel: agent.model,
    resolvedProvider: providerSlug,
    resolvedModel: model,
    fallbackCount: fallbacks.length,
  });

  return { providerSlug, model, fallbacks };
}

/**
 * Find every active provider whose `apiKeyEnvVar` is set in
 * `process.env` (or whose row is `isLocal` and therefore needs no
 * key). Ordered by `createdAt` so the first user-configured provider
 * wins on ties.
 */
async function pickActiveProviderCandidates(): Promise<AiProviderConfig[]> {
  const rows = await prisma.aiProviderConfig.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.filter((row) => row.isLocal || isApiKeyEnvVarSet(row.apiKeyEnvVar));
}
