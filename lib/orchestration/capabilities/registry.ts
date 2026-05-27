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
import { RunWorkflowCapability } from '@/lib/orchestration/capabilities/built-in/run-workflow';
import { UploadToStorageCapability } from '@/lib/orchestration/capabilities/built-in/upload-to-storage';
import { SendMessageToChannelCapability } from '@/lib/orchestration/capabilities/built-in/send-message-to-channel';
import type { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type { CapabilityFunctionDefinition } from '@/lib/orchestration/capabilities/types';

let registered = false;

// ─── App capability registration (fork-readiness seam) ───────────────────────

/**
 * App-contributed capabilities, keyed by slug. An app built on Sunrise
 * pushes into this map at module-import time via `registerAppCapability()`;
 * the map is flushed into the dispatcher on the same lazy path as the
 * built-ins (see `registerBuiltInCapabilities`). Keyed by slug so
 * re-registration under HMR / repeated imports replaces rather than
 * duplicates — mirroring the dispatcher's own per-slug `register()`.
 */
const appCapabilities = new Map<string, BaseCapability>();
let appRegistered = false;

/**
 * Register an app-owned capability so it joins the dispatcher on the next
 * lazy registration pass. Call this at module-import time (alongside the
 * app's other startup wiring), before any dispatch.
 *
 * This is the seam that lets a fork add agent tools without editing
 * `registerBuiltInCapabilities()`. Idempotent by slug: re-registering the
 * same slug replaces the prior instance.
 *
 * @see .context/orchestration/capabilities.md — the app-author guide
 */
export function registerAppCapability(capability: BaseCapability): void {
  appCapabilities.set(capability.slug, capability);
  // A new registration must be flushed even if a prior pass already ran
  // (e.g. an app registers after the first dispatch under HMR).
  appRegistered = false;
}

/**
 * Flush all registered app capabilities into the dispatcher. Idempotent —
 * short-circuits once flushed and re-runs only after a new
 * `registerAppCapability()` call. Invoked from `registerBuiltInCapabilities()`
 * right after the built-ins, so app capabilities are present before the
 * first dispatch in dev and prod alike — NOT a startup hook.
 */
export function registerAppCapabilities(): void {
  if (appRegistered) return;
  for (const capability of appCapabilities.values()) {
    capabilityDispatcher.register(capability);
  }
  appRegistered = true;
}

/**
 * Register every built-in capability with the dispatcher, then flush any
 * app-registered capabilities. Idempotent — repeated imports (HMR, multiple
 * entrypoints) are safe.
 */
export function registerBuiltInCapabilities(): void {
  if (!registered) {
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
    capabilityDispatcher.register(new RunWorkflowCapability());
    capabilityDispatcher.register(new UploadToStorageCapability());
    capabilityDispatcher.register(new SendMessageToChannelCapability());
    registered = true;
  }
  // App capabilities register on the same lazy path, right after the
  // built-ins. Cheap when already flushed (one boolean check).
  registerAppCapabilities();
}

/**
 * Test-only: reset the registration flags and clear app-registered
 * capabilities so each test starts from a known state. Not exported from
 * the barrel.
 */
export function __resetRegistrationForTests(): void {
  registered = false;
  appRegistered = false;
  appCapabilities.clear();
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
