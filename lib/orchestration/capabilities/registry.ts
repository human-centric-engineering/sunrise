/**
 * Capability registry wiring
 *
 * Registers the built-in capability classes with the module-level
 * `capabilityDispatcher` singleton. Also exposes
 * `getCapabilityDefinitions(agentId)` — the source the chat handler
 * will use to populate an LLM's `tools` array.
 *
 * `getCapabilityDefinitions` only returns capabilities that are BOTH:
 * 1. Explicitly enabled on the agent via an `AiAgentCapability` row
 *    that points at an active `AiCapability`, AND
 * 2. Present in the in-memory handler map (i.e. implemented here).
 *
 * This is deliberately stricter than `dispatcher.dispatch()`, which
 * falls through to defaults for agents with no pivot rows. The idea:
 * backend/CLI callers can dispatch anything active, but an LLM should
 * only *see* tools an admin has explicitly turned on.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { capabilityFunctionDefinitionSchema } from '@/lib/validations/orchestration';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { SearchKnowledgeCapability } from '@/lib/orchestration/capabilities/built-in/search-knowledge';
import { GetPatternDetailCapability } from '@/lib/orchestration/capabilities/built-in/get-pattern-detail';
import { EstimateCostCapability } from '@/lib/orchestration/capabilities/built-in/estimate-cost';
import {
  ReadUserMemoryCapability,
  WriteUserMemoryCapability,
} from '@/lib/orchestration/capabilities/built-in/user-memory';
import { EscalateToHumanCapability } from '@/lib/orchestration/capabilities/built-in/escalate-to-human';
import { ApplyAuditChangesCapability } from '@/lib/orchestration/capabilities/built-in/apply-audit-changes';
import { AddProviderModelsCapability } from '@/lib/orchestration/capabilities/built-in/add-provider-models';
import { DeactivateProviderModelsCapability } from '@/lib/orchestration/capabilities/built-in/deactivate-provider-models';
import { CallExternalApiCapability } from '@/lib/orchestration/capabilities/built-in/call-external-api';
import type { CapabilityFunctionDefinition } from '@/lib/orchestration/capabilities/types';

let registered = false;

/**
 * Register every built-in capability with the dispatcher. Idempotent
 * — repeated imports (HMR, multiple entrypoints) are safe.
 */
export function registerBuiltInCapabilities(): void {
  if (registered) return;
  capabilityDispatcher.register(new SearchKnowledgeCapability());
  capabilityDispatcher.register(new GetPatternDetailCapability());
  capabilityDispatcher.register(new EstimateCostCapability());
  capabilityDispatcher.register(new ReadUserMemoryCapability());
  capabilityDispatcher.register(new WriteUserMemoryCapability());
  capabilityDispatcher.register(new EscalateToHumanCapability());
  capabilityDispatcher.register(new ApplyAuditChangesCapability());
  capabilityDispatcher.register(new AddProviderModelsCapability());
  capabilityDispatcher.register(new DeactivateProviderModelsCapability());
  capabilityDispatcher.register(new CallExternalApiCapability());
  registered = true;
}

/**
 * Test-only: reset the registration flag so each test can re-register
 * with a fresh dispatcher state. Not exported from the barrel.
 */
export function __resetRegistrationForTests(): void {
  registered = false;
}

/**
 * Return the OpenAI-compatible function definitions an LLM should see
 * when talking to a given agent. Filters out any definition whose
 * slug isn't registered in the in-memory dispatcher (i.e. anything the
 * DB advertises but the code doesn't actually implement).
 */
export async function getCapabilityDefinitions(
  agentId: string
): Promise<CapabilityFunctionDefinition[]> {
  registerBuiltInCapabilities();
  await capabilityDispatcher.loadFromDatabase();

  const rows = await prisma.aiAgentCapability.findMany({
    where: {
      agentId,
      isEnabled: true,
      capability: { isActive: true },
    },
    include: { capability: true },
  });

  const definitions: CapabilityFunctionDefinition[] = [];
  for (const row of rows) {
    if (!row.capability) continue;
    const parsed = capabilityFunctionDefinitionSchema.safeParse(row.capability.functionDefinition);
    if (!parsed.success) {
      logger.warn('getCapabilityDefinitions: malformed functionDefinition JSON, skipping', {
        agentId,
        slug: row.capability.slug,
        issues: parsed.error.issues,
      });
      continue;
    }
    if (capabilityDispatcher.has(row.capability.slug)) {
      definitions.push(parsed.data);
    }
  }
  return definitions;
}
