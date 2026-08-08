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
import { initAppCapabilities } from '@/lib/app/capabilities';
import type { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityFunctionDefinition,
  CapabilityRegisterOptions,
} from '@/lib/orchestration/capabilities/types';

// ─── Registration state machine ──────────────────────────────────────────────
//
// Three module-scoped flags drive a small lazy-flush state machine so the
// built-ins, the fork's auto-wired init, and any direct `registerAppCapability`
// calls all reach the dispatcher exactly once per change — never on every
// dispatch.
//
//   registered      false → true (one-shot)
//     Set after the 13 built-in capabilities are pushed into the dispatcher
//     inside `registerBuiltInCapabilities`. Never reset except by the test-only
//     `__resetRegistrationForTests`. Guards the built-in flush from re-running.
//
//   appInited       false → true (one-shot per app file)
//     Set after `initAppCapabilities()` (the fork's `lib/app/capabilities.ts`
//     hook) runs. Lets the fork accumulate capabilities at module-import time
//     by calling `registerAppCapability(...)`, without that init firing on
//     every dispatch.
//
//   appRegistered   true ↔ false (re-armable)
//     Set after `registerAppCapabilities` flushes the `appCapabilities` map
//     into the dispatcher. RESET back to `false` by `registerAppCapability`
//     so a late-arriving capability (e.g. under HMR or a delayed import) is
//     picked up on the next `registerBuiltInCapabilities` call. This is the
//     only flag with two-way transitions; the other two are one-shot.
//
// Order on every call to `registerBuiltInCapabilities`:
//   1. Flush built-ins (gated by `registered`).
//   2. Run app init hook (gated by `appInited`).
//   3. Flush app capabilities (gated by `appRegistered`).
//
// `__resetRegistrationForTests` clears all three (and the `appCapabilities`
// map) so each test starts from a clean slate.
let registered = false;
/** Whether the auto-wired app capability init (`lib/app/capabilities.ts`) has run. */
let appInited = false;

// ─── App capability registration (fork-readiness seam) ───────────────────────

/**
 * App-contributed capabilities, keyed by slug. An app built on Sunrise
 * pushes into this map at module-import time via `registerAppCapability()`;
 * the map is flushed into the dispatcher on the same lazy path as the
 * built-ins (see `registerBuiltInCapabilities`). Keyed by slug so
 * re-registration under HMR / repeated imports replaces rather than
 * duplicates — mirroring the dispatcher's own per-slug `register()`.
 */
const appCapabilities = new Map<
  string,
  { capability: BaseCapability; options?: CapabilityRegisterOptions }
>();
let appRegistered = false;

/**
 * Register an app-owned capability so it joins the dispatcher on the next
 * lazy registration pass. Call this at module-import time (alongside the
 * app's other startup wiring), before any dispatch.
 *
 * This is the seam that lets a fork add agent tools without editing
 * `registerBuiltInCapabilities()`. Idempotent by registration key
 * (`options.slug ?? capability.slug`): re-registering the same key replaces
 * the prior instance.
 *
 * `options` (both fields opt-in) is forwarded verbatim to
 * `capabilityDispatcher.register` — pass `slug` to mount one capability class
 * under a namespaced slug, and/or `guard` to gate its dispatch. See
 * {@link CapabilityRegisterOptions} for the slug↔active-row contract.
 *
 * @see .context/orchestration/capabilities.md — the app-author guide
 */
export function registerAppCapability(
  capability: BaseCapability,
  options?: CapabilityRegisterOptions
): void {
  appCapabilities.set(options?.slug ?? capability.slug, { capability, options });
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
  for (const { capability, options } of appCapabilities.values()) {
    capabilityDispatcher.register(capability, options);
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
  // Auto-wire the app's capability registrations (fork-readiness — the
  // `lib/app/` bootstrap surface). Runs once, here in the server route-handler
  // realm, so a fork's `registerAppCapability()` calls in `lib/app/capabilities.ts`
  // land before the flush below — no separate wiring step. Guarded so it isn't
  // re-run on every dispatch; direct `registerAppCapability()` callers still
  // flush via the `appRegistered` path.
  if (!appInited) {
    initAppCapabilities();
    appInited = true;
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
  appInited = false;
  appCapabilities.clear();
}

/**
 * The charset every supported provider accepts for a tool name. Pinned for
 * Anthropic in `lib/orchestration/llm/anthropic.ts`; OpenAI is the same for
 * tools. A capability slug has to satisfy it to be advertised, because the
 * slug *is* the advertised name (#509).
 */
const LLM_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Slug→name pairs already warned about, so a divergent row does not emit a
 * warning on every chat turn and every `agent_call` step for the life of the
 * process. The whole design is that such a row keeps working indefinitely, so
 * without this the log fills with one line per request, forever.
 *
 * Keyed on the exact pair, which is what makes this dedupe safe where the one
 * attempted in #553 was not: that key collapsed distinct values into a single
 * rendered token and so could hide a *second*, different misconfiguration
 * behind the first. Two different divergent rows produce two different keys
 * here, and a row that changes produces a new key. Process-lifetime only, so a
 * redeploy re-announces everything still outstanding.
 */
const warnedDivergentPairs = new Set<string>();

function warnOnceForDivergence(
  agentId: string,
  slug: string,
  functionDefinitionName: string
): void {
  const key = `${slug}=>${functionDefinitionName}`;
  if (warnedDivergentPairs.has(key)) return;
  warnedDivergentPairs.add(key);

  logger.warn('Capability functionDefinition.name differs from slug; advertising the slug', {
    slug,
    functionDefinitionName,
    // Named for what it is. Because the warning is emitted once per pair, this
    // is whichever agent resolved the row first after boot — NOT the set of
    // agents the capability is bound to. Reading it as the latter would send an
    // operator to the wrong agent.
    firstObservedOnAgentId: agentId,
  });
}

/** Test seam: clears the warn-once memo so cases don't leak into each other. */
export function __resetDivergenceWarningsForTests(): void {
  warnedDivergentPairs.clear();
}

/**
 * Return the OpenAI-compatible function definitions an LLM should see
 * when talking to a given agent. Filters out any definition whose
 * slug isn't registered in the in-memory dispatcher (i.e. anything the
 * DB advertises but the code doesn't actually implement), or whose slug
 * cannot be a tool name.
 *
 * **The advertised `name` is the capability slug, not the stored
 * `functionDefinition.name`** — see the comment at the push site for why.
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
      // Since the slug becomes the advertised tool name, it has to be legal as
      // one. Providers reject the ENTIRE request over a malformed tool name
      // (Anthropic's charset is pinned in `llm/anthropic.ts`), so advertising
      // a namespaced fork slug like `billing:lookup_order` — the documented
      // `register(cap, { slug })` seam — would kill the whole conversation
      // rather than one tool call.
      //
      // Such a capability was never reachable from chat anyway: dispatch
      // resolves the emitted name as a slug, and no valid-charset name can
      // match a namespaced row. Dropping it from the toolset makes that
      // explicit instead of trading a silent per-call failure for a fatal one.
      // MCP remains its supported surface — `mcp/tool-registry.ts` advertises
      // `customName` and resolves it back to the slug before dispatch.
      if (!LLM_TOOL_NAME.test(row.capability.slug)) {
        logger.warn('Capability slug is not a valid LLM tool name; not advertising it', {
          agentId,
          slug: row.capability.slug,
        });
        continue;
      }

      // Advertise the SLUG as the tool name, not `functionDefinition.name`.
      //
      // Dispatch takes the name the model emitted and resolves it as a slug,
      // so the name a capability advertises and the slug that selects the
      // handler must be the same string. Nothing used to require that
      // (`capabilityFunctionDefinitionSchema` still doesn't — it validates the
      // JSON column alone and cannot see the slug), and the #476 tool-call
      // guard keyed on the name while dispatch keyed on the slug. A row with
      // `slug: 'estimate_workflow_cost'` and `name: 'apply_audit_changes'`
      // was therefore *checked* as one capability and *executed* as another
      // (#509).
      //
      // Overriding here rather than rejecting is deliberate: this is the READ
      // path, and dropping the row would silently strip the tool from the
      // agent. Divergence is refused at the write boundary instead (see
      // `createCapabilitySchema` / `updateCapabilitySchema`), so this is the
      // backstop for rows written before that landed, restored from a backup
      // bundle, or inserted straight into the database.
      //
      // It also makes the two `SEARCH_KNOWLEDGE_SLUG` comparisons in
      // `chat/streaming-handler.ts` — which match a slug constant against a
      // tool *name* — correct by construction rather than by luck.
      if (parsed.data.name !== row.capability.slug) {
        warnOnceForDivergence(agentId, row.capability.slug, parsed.data.name);
      }
      definitions.push({ ...parsed.data, name: row.capability.slug });
    }
  }
  return definitions;
}
