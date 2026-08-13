/**
 * Capability Dispatcher
 *
 * The runtime that translates a capability call (from the chat handler
 * or an admin API route) into a concrete `execute()` on a
 * `BaseCapability` subclass, guarded by:
 *
 * 1. In-memory handler lookup (fast path).
 * 2. DB-backed `AiCapability` registry — controls `isActive`,
 *    `requiresApproval`, and `rateLimit` without a redeploy.
 * 3. Per-agent `AiAgentCapability` binding — controls `isEnabled`
 *    and `customRateLimit`.
 * 4. Sliding-window rate limiter keyed by `(slug, agentId)`.
 * 5. Zod argument validation.
 *
 * Both the capability registry and per-agent bindings are cached for
 * `CACHE_TTL_MS`; callers that mutate `AiCapability` /
 * `AiAgentCapability` rows should call `clearCache()` afterwards.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { env } from '@/lib/env';
import { logger } from '@/lib/logging';
import { createRateLimiter, type RateLimiter } from '@/lib/security/rate-limit';
import { CostOperation } from '@/types/orchestration';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { logCost } from '@/lib/orchestration/llm/cost-tracker';
import { capabilityFunctionDefinitionSchema } from '@/lib/validations/orchestration';
import {
  BaseCapability,
  CapabilityValidationError,
} from '@/lib/orchestration/capabilities/base-capability';
import type {
  AgentCapabilityBinding,
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityGuard,
  CapabilityGuardDecision,
  CapabilityRegisterOptions,
  CapabilityRegistryEntry,
  CapabilityResult,
  QuarantineState,
} from '@/lib/orchestration/capabilities/types';
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_TOOL_NAME,
  SPAN_CAPABILITY_DISPATCH,
  SUNRISE_AGENT_ID,
  SUNRISE_CAPABILITY_SLUG,
  SUNRISE_CAPABILITY_SUCCESS,
  SUNRISE_CONVERSATION_ID,
  SUNRISE_USER_ID,
  setSpanAttributes,
  withSpan,
} from '@/lib/orchestration/tracing';

/**
 * Prefix marking a `CapabilityContext.agentId` that is a LABEL, not an
 * `AiAgent.id`. A workflow execution isn't bound to an agent, so the
 * `tool_call` executor dispatches under `workflow:${workflowId}` to keep rate
 * limits scoped per-workflow (see {@link workflowAgentId}).
 *
 * The prefix is a constant rather than an inline template in each file
 * because two modules have to agree on it: the executor mints it and
 * {@link CapabilityDispatcher.getAgentBinding} has to recognise it. They
 * disagreed in exactly that way in #528.
 */
export const WORKFLOW_AGENT_ID_PREFIX = 'workflow:';

/**
 * Build the synthetic `agentId` a workflow's `tool_call` steps dispatch under.
 *
 * ⚠️ **This value is not an `AiAgent.id` and must never be written to a column
 * with a foreign key to one.** More than one table has such a column —
 * `AiAgentCapability.agentId` (which is why strict mode needed the exemption
 * below) and `AiCostLog.agentId` — and Postgres rejects the insert with P2003.
 * Treat it as a label for in-memory scoping (rate-limit buckets, log context),
 * not as a persistable id.
 */
export function workflowAgentId(workflowId: string): string {
  return `${WORKFLOW_AGENT_ID_PREFIX}${workflowId}`;
}

/**
 * True when an `agentId` is a workflow label rather than a real agent id.
 *
 * Safe as a prefix test because `AiAgent.id` is a cuid — no colons — so no
 * real agent can collide, and no caller passes an attacker-chosen `agentId`
 * (every other `dispatch()` call site passes a row's own `id`).
 */
export function isWorkflowAgentId(agentId: string): boolean {
  return agentId.startsWith(WORKFLOW_AGENT_ID_PREFIX);
}

/**
 * Parse a Prisma `Json` value from `AiCapability.functionDefinition` into a
 * trusted `CapabilityFunctionDefinition`. Returns `null` (with a warn log)
 * if the row's JSON shape doesn't match — the caller is expected to skip
 * the row entirely so a malformed registry entry can't reach a dispatch.
 */
function parseFunctionDefinition(
  value: unknown,
  context: { slug: string; agentId?: string }
): CapabilityFunctionDefinition | null {
  const parsed = capabilityFunctionDefinitionSchema.safeParse(value);
  if (!parsed.success) {
    logger.warn('Capability registry: malformed functionDefinition JSON, skipping row', {
      ...context,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}

/**
 * Normalise a pivot row's `customConfig` JSON to a plain object or `null`.
 * The column is `Json?`, so it may be null, a scalar, or an array — none of
 * which a per-binding config consumer expects — so anything that isn't a
 * plain object collapses to `null`. The `as` cast is guarded by the runtime
 * `typeof`/`Array.isArray` checks; the value stays opaque (consumers validate
 * it, e.g. with Zod, before reading keys).
 */
function normalizeCustomConfig(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Cache lifetime for both the registry and per-agent bindings. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;

class CapabilityDispatcher {
  private handlers = new Map<string, BaseCapability>();
  private guards = new Map<string, CapabilityGuard>();
  private registry = new Map<string, CapabilityRegistryEntry>();
  private rateLimiters = new Map<string, RateLimiter>();
  private agentBindings = new Map<string, Map<string, AgentCapabilityBinding>>();

  private registryFetchedAt = 0;
  private inflightLoad: Promise<void> | null = null;
  private agentBindingsFetchedAt = new Map<string, number>();
  private inflightBindingLoads = new Map<string, Promise<void>>();

  /**
   * Register an in-memory capability handler. Idempotent: re-registering
   * the same key replaces the previous handler *and* its guard together.
   *
   * Throws if a capability declares `processesPii = true` but does not
   * override `redactProvenance()`. Forces capability authors to make an
   * explicit decision about what gets persisted onto durable audit
   * rows — silent passthrough for PII-handling capabilities is a
   * footgun, not a feature.
   *
   * `options` is a fork seam (both fields opt-in; the no-options call is
   * unchanged):
   * - `slug` overrides the handler key (defaults to `capability.slug`). See
   *   the ⚠️ contract on {@link CapabilityRegisterOptions.slug}: the override
   *   must map to an active `AiCapability` row or dispatch dies at
   *   `capability_inactive`.
   * - `guard` attaches a pre-execute predicate run as a dispatch gate.
   *
   * The PII check inspects the real (unwrapped) `capability` instance, so
   * `isRedactorOverridden` sees the true subclass prototype regardless of a
   * slug override — this seam is exactly what lets a fork avoid wrapping a
   * capability (which would have defeated that own-property check).
   */
  register(capability: BaseCapability, options?: CapabilityRegisterOptions): void {
    if (capability.processesPii && !isRedactorOverridden(capability)) {
      throw new Error(
        `Capability "${capability.slug}" declares processesPii=true but does not ` +
          `override redactProvenance(). PII-handling capabilities must implement ` +
          `explicit redaction. See .context/security/pii-redaction.md`
      );
    }
    const key = options?.slug ?? capability.slug;
    this.handlers.set(key, capability);
    // Replace the guard atomically with the handler: a re-registration without
    // a guard must drop any guard a prior registration left under this key.
    if (options?.guard) {
      this.guards.set(key, options.guard);
    } else {
      this.guards.delete(key);
    }
  }

  has(slug: string): boolean {
    return this.handlers.has(slug);
  }

  /**
   * Look up a registered capability instance by slug. The chat handler
   * uses this to call `redactProvenance()` before building the trace
   * row that gets persisted onto the assistant message's audit bundle.
   * Returns `undefined` if no handler is registered under that slug.
   */
  getHandler(slug: string): BaseCapability | undefined {
    return this.handlers.get(slug);
  }

  getRegistryEntry(slug: string): CapabilityRegistryEntry | undefined {
    return this.registry.get(slug);
  }

  /**
   * Force a refresh of the next `loadFromDatabase` / `getAgentBinding`
   * call. Useful after admin mutations and in tests.
   */
  clearCache(): void {
    this.registry.clear();
    this.rateLimiters.clear();
    this.agentBindings.clear();
    this.agentBindingsFetchedAt.clear();
    this.inflightLoad = null;
    this.inflightBindingLoads.clear();
    this.registryFetchedAt = 0;
  }

  /**
   * Load active `AiCapability` rows into the in-memory registry map.
   * Dedupes concurrent calls and short-circuits while the TTL is fresh.
   */
  async loadFromDatabase(): Promise<void> {
    const now = Date.now();
    if (this.registryFetchedAt && now - this.registryFetchedAt < CACHE_TTL_MS) {
      return;
    }
    if (this.inflightLoad) {
      return this.inflightLoad;
    }
    this.inflightLoad = (async () => {
      try {
        const rows = await prisma.aiCapability.findMany({ where: { isActive: true } });
        const next = new Map<string, CapabilityRegistryEntry>();
        for (const row of rows) {
          const entry = mapRowToEntry(row);
          if (entry) next.set(row.slug, entry);
        }
        this.registry = next;
        this.registryFetchedAt = Date.now();
        // Rate-limit windows may have changed, drop cached instances.
        this.rateLimiters.clear();
      } finally {
        this.inflightLoad = null;
      }
    })();
    return this.inflightLoad;
  }

  /**
   * Execute a capability end-to-end. Every outcome is represented as a
   * `CapabilityResult` — we never throw at the dispatcher boundary.
   */
  async dispatch(
    slug: string,
    rawArgs: unknown,
    context: CapabilityContext
  ): Promise<CapabilityResult> {
    const startedAt = Date.now();

    // 1. Load (or refresh) the DB-backed registry.
    await this.loadFromDatabase();

    // 2. In-memory handler lookup.
    const handler = this.handlers.get(slug);
    if (!handler) {
      logger.warn('Capability dispatch: unknown slug', { slug, agentId: context.agentId });
      return {
        success: false,
        error: { code: 'unknown_capability', message: `Unknown capability: ${slug}` },
      };
    }

    // 3. Registry lookup — only active rows land in the map.
    const entry = this.registry.get(slug);
    if (!entry) {
      logger.warn('Capability dispatch: inactive capability', {
        slug,
        agentId: context.agentId,
      });
      return {
        success: false,
        error: { code: 'capability_inactive', message: `Capability is not active: ${slug}` },
      };
    }

    // 3a. Quarantine gate. Distinct from isActive — see
    //     `.context/orchestration/capabilities.md` (Quarantine section).
    //     `quarantineUntil` is checked at read time: a past timestamp is
    //     treated as `active` without mutating the row (the field is kept
    //     for audit). Soft mode returns a structured error the agent can
    //     route around via plan / orchestrator; hard mode sets
    //     skipFollowup so the model's tool loop terminates.
    const effectiveQuarantine = resolveQuarantineState(entry);
    if (effectiveQuarantine !== 'active') {
      logger.warn('Capability dispatch: quarantined', {
        slug,
        mode: effectiveQuarantine,
        reason: entry.quarantineReason,
        agentId: context.agentId,
      });
      return {
        success: false,
        error: {
          code: 'capability_quarantined',
          message:
            effectiveQuarantine === 'quarantined-hard'
              ? `Capability ${slug} is unavailable (disabled by admin)`
              : `Capability ${slug} is temporarily unavailable${
                  entry.quarantineReason ? `: ${entry.quarantineReason}` : ''
                }`,
        },
        skipFollowup: effectiveQuarantine === 'quarantined-hard',
        // Hard mode deliberately omits the reason — the chat handler
        // persists the role:tool message verbatim and rehydrates it on
        // the next user turn, so a reason in metadata would survive past
        // the in-turn `skipFollowup` short-circuit and give the model
        // operational details to drive a retry. Soft mode keeps the
        // reason so the agent can describe the unavailability to the
        // user and route around it.
        metadata:
          effectiveQuarantine === 'quarantined-hard'
            ? { mode: effectiveQuarantine }
            : { mode: effectiveQuarantine, reason: entry.quarantineReason },
      };
    }

    // 4. Per-agent binding. Missing pivot rows fall through to the
    //    defaults from the base capability — the admin UI uses opt-out
    //    semantics.
    //    `null` is only reachable under CAPABILITY_BINDING_MODE=strict, where a
    //    missing row denies rather than defaulting to allow. Testing `!binding`
    //    rather than `binding &&` matters: the latter would let a strict-mode
    //    denial fall through to a successful dispatch, silently making the
    //    setting a no-op.
    const binding = await this.getAgentBinding(context.agentId, slug, entry);
    if (!binding || binding.isEnabled === false) {
      logger.warn('Capability dispatch: disabled for agent', {
        slug,
        agentId: context.agentId,
        reason: binding ? 'binding_disabled' : 'no_binding_row_strict_mode',
      });
      return {
        success: false,
        error: {
          code: 'capability_disabled_for_agent',
          // No agent id in the message: it's surfaced verbatim to clients (e.g.
          // the MCP tool-registry passes `result.error.message` through), and
          // the internal cuid adds nothing a scoped caller can act on. The
          // agentId stays in the structured `logger.warn` above for operators.
          message: `Capability ${slug} is disabled for this agent`,
        },
      };
    }

    // Surface the resolved binding onto the execution context so a capability
    // can read its own per-binding `customConfig` / enablement inside
    // `execute()` without re-querying `AiAgentCapability` — the binding was
    // just resolved above. A shallow copy leaves the caller's context object
    // untouched. `customConfig` stays an opaque carrier (consumers validate);
    // `isEnabled` is always `true` here (a disabled binding returned above).
    const executionContext: CapabilityContext = {
      ...context,
      customConfig: binding?.customConfig ?? null,
      isEnabled: binding?.isEnabled ?? true,
    };

    // 4a. Capability guard. A fork-attached pre-execute predicate gating on
    //     the generic `context.scope` carrier (e.g. refuse a tool outside its
    //     module/tenant). Runs after enablement, before the rate limiter, so a
    //     denied call consumes no rate token. Inert unless a fork passed
    //     `{ guard }` to `register()` — core registers none.
    const guard = this.guards.get(slug);
    if (guard) {
      let decision: CapabilityGuardDecision;
      try {
        decision = await guard(context);
      } catch (err) {
        // Fail closed: a guard whose purpose is to restrict must not be
        // bypassed by its own bug. Deny and log; the reason is withheld from
        // the client since it's an internal error, not a policy decision.
        logger.error('Capability dispatch: guard threw — denying', {
          slug,
          agentId: context.agentId,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          success: false,
          error: {
            code: 'capability_guard_denied',
            message: `Capability ${slug} was blocked by a guard`,
          },
        };
      }
      if (!decision.allow) {
        logger.warn('Capability dispatch: guard denied', {
          slug,
          agentId: context.agentId,
          reason: decision.reason,
        });
        return {
          success: false,
          error: {
            code: 'capability_guard_denied',
            // `reason` folded in when the guard supplied one; no internal ids —
            // this message is surfaced verbatim to clients (mirrors the
            // binding-gate contract above).
            message: decision.reason
              ? `Capability ${slug} was blocked: ${decision.reason}`
              : `Capability ${slug} was blocked by a guard`,
          },
        };
      }
    }

    // 5. Rate limit. Effective limit is the binding override, else the
    //    base capability's `rateLimit`. `null` = unlimited.
    const effectiveLimit = binding?.effectiveRateLimit ?? entry.rateLimit;
    if (effectiveLimit !== null && effectiveLimit > 0) {
      const limiter = this.getOrCreateRateLimiter(slug, effectiveLimit);
      const result = limiter.check(context.agentId);
      if (!result.success) {
        logger.warn('Capability dispatch: rate limited', {
          slug,
          agentId: context.agentId,
          limit: effectiveLimit,
        });
        return {
          success: false,
          error: {
            code: 'rate_limited',
            message: `Rate limit exceeded for capability ${slug} (${effectiveLimit}/min)`,
          },
        };
      }
    }

    // 6. Approval gate — includes timeout metadata for the approval UI.
    if (entry.requiresApproval) {
      let timeoutMs: number | null = entry.approvalTimeoutMs;
      let defaultAction: string = 'deny';
      if (timeoutMs === null) {
        try {
          const settings = await getOrchestrationSettings();
          timeoutMs = settings.defaultApprovalTimeoutMs;
          defaultAction = settings.approvalDefaultAction ?? 'deny';
        } catch {
          // Settings unavailable — proceed with no timeout
        }
      }

      logger.info('Capability dispatch: requires approval', {
        slug,
        agentId: context.agentId,
        timeoutMs,
        defaultAction,
      });
      return {
        success: false,
        error: {
          code: 'requires_approval',
          message: 'Capability requires admin approval',
        },
        skipFollowup: true,
        metadata: {
          timeoutMs,
          defaultAction,
        },
      };
    }

    // Steps 7–9 wrapped in a span. Earlier guard returns are not
    // wrapped — they don't represent real tool work and producing
    // spans for them would pollute the trace UI with noise.
    return withSpan(
      SPAN_CAPABILITY_DISPATCH,
      {
        [SUNRISE_CAPABILITY_SLUG]: slug,
        [GEN_AI_TOOL_NAME]: slug,
        [GEN_AI_OPERATION_NAME]: 'tool_call',
        [SUNRISE_AGENT_ID]: context.agentId,
        [SUNRISE_USER_ID]: context.userId ?? '',
        ...(context.conversationId ? { [SUNRISE_CONVERSATION_ID]: context.conversationId } : {}),
      },
      async (span) => {
        // 7. Validate args.
        let validated: unknown;
        try {
          validated = handler.validate(rawArgs);
        } catch (err) {
          if (err instanceof CapabilityValidationError) {
            logger.warn('Capability dispatch: invalid args', {
              slug,
              agentId: context.agentId,
              issues: err.issues,
            });
            setSpanAttributes(span, { [SUNRISE_CAPABILITY_SUCCESS]: false });
            return {
              success: false,
              error: {
                code: 'invalid_args',
                message: formatValidationIssues(err.issues),
              },
            };
          }
          throw err;
        }

        // 8. Execute. Any unexpected throw is normalised to execution_error.
        //    Uses the binding-enriched context (customConfig / isEnabled).
        let result: CapabilityResult;
        try {
          result = await handler.execute(validated, executionContext);
        } catch (err) {
          logger.error('Capability dispatch: execution threw', {
            slug,
            agentId: context.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
          setSpanAttributes(span, { [SUNRISE_CAPABILITY_SUCCESS]: false });
          return {
            success: false,
            error: {
              code: 'execution_error',
              message: err instanceof Error ? err.message : 'Capability execution failed',
            },
          };
        }

        setSpanAttributes(span, { [SUNRISE_CAPABILITY_SUCCESS]: result.success });

        // 9. Fire-and-forget cost log. The LLM call that triggered this
        //    tool already logged its own tokens, so we record zeros and
        //    rely on the `operation: 'tool_call'` breakdown for per-tool
        //    analytics.
        //    `agentId` is written only when it is a real `AiAgent.id`. A
        //    workflow label is not one, and `AiCostLog.agentId` is a foreign
        //    key to `AiAgent.id` — so writing the label violated
        //    `ai_cost_log_agentId_fkey` (P2003). `logCost` catches and swallows
        //    that, which meant every capability invoked from a workflow logged
        //    an error and recorded NO cost row: the Costs page's per-tool
        //    breakdown under-reported workflow tool usage to zero.
        //    `workflowExecutionId` is the column that models this properly, and
        //    its FK is satisfied — the execution row exists before any step runs.
        void logCost({
          ...(context.agentId && !isWorkflowAgentId(context.agentId)
            ? { agentId: context.agentId }
            : {}),
          ...(context.workflowExecutionId
            ? { workflowExecutionId: context.workflowExecutionId }
            : {}),
          ...(context.conversationId ? { conversationId: context.conversationId } : {}),
          operation: CostOperation.TOOL_CALL,
          model: 'n/a',
          provider: 'capability',
          inputTokens: 0,
          outputTokens: 0,
          traceId: span.traceId(),
          spanId: span.spanId(),
          metadata: { slug, success: result.success },
        }).catch((err) => {
          logger.error('Capability dispatch: logCost rejected', {
            slug,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        logger.info('Capability dispatched', {
          slug,
          agentId: context.agentId,
          success: result.success,
          latencyMs: Date.now() - startedAt,
        });

        return result;
      }
    );
  }

  /**
   * Lazy-load and cache per-agent bindings. A missing pivot row is
   * treated as "use the capability defaults", so backend/CLI callers
   * can dispatch without any explicit admin wiring.
   *
   * ## Deleting a grant does NOT revoke a capability
   *
   * Read that twice, because absence reads like the safe state and is not.
   * When no `AiAgentCapability` row exists this synthesizes a default-ALLOW
   * binding, so the intuitive way to withdraw a capability — delete the pivot
   * row — leaves it **dispatchable and unrestricted**, where before it was
   * dispatchable and restricted. An operator action that reads as "remove this
   * permission" is the one that widens it: a binding pinned via `customConfig`
   * to a narrow scope becomes an unpinned binding with no restriction at all.
   *
   * To actually revoke, set `isEnabled: false` and KEEP the row —
   * {@link dispatch} checks that before any exposure logic and refuses
   * outright. Keeping the row also matters because the state needing repair is
   * an absent one, and absence carries no record of what used to be there.
   *
   * Setting `CAPABILITY_BINDING_MODE=strict` inverts the default so a missing
   * row denies instead. It is opt-in because flipping it retroactively revokes
   * every capability any agent was relying on implicitly — including the
   * `mcp-system` agent, which dispatches built-ins with no pivot rows in a
   * default install. Audit your `AiAgentCapability` table before enabling it.
   *
   * **Workflow `tool_call` steps are exempt from `strict`** — see the
   * short-circuit at the top of the method. That advice ("audit the table
   * first") is only actionable for a caller whose `agentId` is a real
   * `AiAgent.id`; a workflow's is not, and the FK makes the row strict mode
   * asks for impossible to insert (#528).
   *
   * Independently of this setting, here is what each caller checks before it
   * gets here. THREE of the four take a name from a model.
   *
   * - `chat/streaming-handler.ts` and `engine/executors/agent-call.ts` —
   *   model-emitted, both checked against the calling agent's advertised set
   *   (`advertisedToolNames`, built from `getCapabilityDefinitions`).
   * - `mcp/tool-registry.ts` — ALSO model-emitted; the host behind an MCP key
   *   is an LLM. Checked against the globally EXPOSED-TOOL set (publishing an
   *   `McpExposedTool` row is the grant), but NOT against the calling key's
   *   scoped agent — and with no pivot row for that agent this method
   *   default-allows, so a scoped key can reach an exposed tool its agent was
   *   never granted. Deliberate opt-out scoping, documented in
   *   `.context/orchestration/mcp.md` with the open question of whether scoped
   *   should mean allow-list-only.
   * - `executors/tool-call.ts` — the only one that is NOT model-driven:
   *   `capabilitySlug` comes from Zod-parsed, admin-authored step config.
   *   Nothing synthesizes a `tool_call` step at runtime; an orchestrator or
   *   `plan` step delegates to `agent_call`, which dispatches under the real
   *   agent id and is checked against that agent's advertised set. This is
   *   what makes the workflow exemption above safe rather than convenient.
   *
   * An earlier draft of this note listed MCP among the callers that "do not
   * take a name from a model at all" and then contradicted itself two lines
   * later. Stated plainly here because a reader who stops at the first
   * sentence is exactly who this note keeps failing.
   *
   * This note used to say "the chat handler … closes the reachable path". That
   * was true of chat and false of `agent_call`, which had no such check until
   * #559 — so a sentence intended to explain why the default is safe was, for
   * anyone weighing `strict`, the reason not to look.
   */
  private async getAgentBinding(
    agentId: string,
    slug: string,
    entry: CapabilityRegistryEntry
  ): Promise<AgentCapabilityBinding | null> {
    // What a caller gets when no pivot row narrows the capability: the base
    // entry's own defaults. Named because two paths now return it.
    const defaultAllowBinding = (): AgentCapabilityBinding => ({
      slug,
      isEnabled: true,
      effectiveRateLimit: entry.rateLimit,
      customConfig: null,
      functionDefinition: entry.functionDefinition,
      requiresApproval: entry.requiresApproval,
    });

    // A workflow label is not an agent id, so there is no row to look for:
    // `AiAgentCapability.agentId` is a FK to `AiAgent.id`, and the FK rejects
    // `workflow:<cuid>`. That is what separates this from the `mcp-system`
    // caveat above — an operator told to "create the binding rows first"
    // literally cannot, so under `strict` EVERY tool_call step in EVERY
    // workflow failed with `capability_disabled_for_agent` and no available
    // remedy (#528).
    //
    // Under `permissive` this changes nothing: the query could only ever
    // return zero rows, so it already fell through to the same binding — this
    // just stops issuing it.
    if (isWorkflowAgentId(agentId)) return defaultAllowBinding();

    const now = Date.now();
    const fetchedAt = this.agentBindingsFetchedAt.get(agentId) ?? 0;

    if (!fetchedAt || now - fetchedAt >= CACHE_TTL_MS) {
      const existing = this.inflightBindingLoads.get(agentId);
      if (existing) {
        await existing;
      } else {
        const load = (async () => {
          try {
            const rows = await prisma.aiAgentCapability.findMany({
              where: { agentId },
              include: { capability: true },
            });
            const map = new Map<string, AgentCapabilityBinding>();
            for (const row of rows) {
              if (!row.capability) continue;
              const functionDefinition = parseFunctionDefinition(
                row.capability.functionDefinition,
                { slug: row.capability.slug, agentId }
              );
              if (!functionDefinition) continue;
              map.set(row.capability.slug, {
                slug: row.capability.slug,
                isEnabled: row.isEnabled,
                effectiveRateLimit: row.customRateLimit ?? row.capability.rateLimit ?? null,
                customConfig: normalizeCustomConfig(row.customConfig),
                functionDefinition,
                requiresApproval: row.capability.requiresApproval,
              });
            }
            this.agentBindings.set(agentId, map);
            this.agentBindingsFetchedAt.set(agentId, Date.now());
          } finally {
            this.inflightBindingLoads.delete(agentId);
          }
        })();
        this.inflightBindingLoads.set(agentId, load);
        await load;
      }
    }

    const agentMap = this.agentBindings.get(agentId);
    const binding = agentMap?.get(slug);
    if (binding) return binding;

    // No explicit row. In strict mode that denies; by default it synthesizes a
    // default-allow binding from the base capability entry (no pivot row means
    // no per-binding config). See the revocation note on this method.
    if (env.CAPABILITY_BINDING_MODE === 'strict') {
      logger.warn('Capability dispatch denied: no binding row and CAPABILITY_BINDING_MODE=strict', {
        agentId,
        slug,
      });
      return null;
    }

    return defaultAllowBinding();
  }

  private getOrCreateRateLimiter(slug: string, maxRequests: number): RateLimiter {
    const existing = this.rateLimiters.get(slug);
    if (existing) return existing;
    const limiter = createRateLimiter({
      interval: RATE_LIMIT_WINDOW_MS,
      maxRequests,
    });
    this.rateLimiters.set(slug, limiter);
    return limiter;
  }
}

interface AiCapabilityRow {
  id: string;
  slug: string;
  name: string;
  category: string;
  functionDefinition: unknown;
  requiresApproval: boolean;
  approvalTimeoutMs: number | null;
  rateLimit: number | null;
  isIdempotent: boolean;
  isActive: boolean;
  quarantineState: string;
  quarantineReason: string | null;
  quarantineUntil: Date | null;
}

function mapRowToEntry(row: AiCapabilityRow): CapabilityRegistryEntry | null {
  const functionDefinition = parseFunctionDefinition(row.functionDefinition, { slug: row.slug });
  if (!functionDefinition) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    functionDefinition,
    requiresApproval: row.requiresApproval,
    approvalTimeoutMs: row.approvalTimeoutMs ?? null,
    rateLimit: row.rateLimit,
    isIdempotent: row.isIdempotent,
    isActive: row.isActive,
    quarantineState: normaliseQuarantineState(row.quarantineState),
    quarantineReason: row.quarantineReason,
    quarantineUntil: row.quarantineUntil,
  };
}

/**
 * Guard against a stored quarantineState value that doesn't match the enum
 * (e.g. a future state added by an out-of-band migration on an older deploy).
 * Unknown values fail open to 'active' so a corrupt row can't disable a
 * capability silently.
 */
function normaliseQuarantineState(value: string): QuarantineState {
  if (value === 'quarantined-soft' || value === 'quarantined-hard') return value;
  return 'active';
}

/**
 * Resolve the *effective* quarantine state of a registry entry, accounting
 * for read-time auto-expiry. A past `quarantineUntil` returns `'active'`
 * without mutating the row — the column is preserved for audit. Callers
 * that need to render the stored state in admin UI should read
 * `entry.quarantineState` directly.
 *
 * Accepts `string` for `quarantineState` so callers reading a raw Prisma
 * row (where the column is typed `string`, not the union) can call this
 * directly without an `as` cast — values that don't match the enum fall
 * open to `'active'` via the same `normaliseQuarantineState` guard the
 * registry loader uses. This keeps every read path consistent and
 * removes a class of CLAUDE.md "no `as` on external data" violations.
 */
export function resolveQuarantineState(entry: {
  quarantineState: string;
  quarantineUntil: Date | null;
}): QuarantineState {
  const stored = normaliseQuarantineState(entry.quarantineState);
  if (stored === 'active') return 'active';
  if (entry.quarantineUntil !== null && entry.quarantineUntil.getTime() <= Date.now()) {
    return 'active';
  }
  return stored;
}

function formatValidationIssues(issues: unknown[]): string {
  if (!Array.isArray(issues) || issues.length === 0) {
    return 'Invalid arguments';
  }
  const parts = issues.map((issue) => {
    if (issue && typeof issue === 'object' && 'message' in issue) {
      const path =
        'path' in issue && Array.isArray((issue as { path: unknown[] }).path)
          ? (issue as { path: unknown[] }).path.join('.')
          : '';
      const message = String(issue.message);
      return path ? `${path}: ${message}` : message;
    }
    return String(issue);
  });
  return parts.join('; ');
}

/**
 * Process-wide singleton, backed by `globalThis`.
 *
 * Next 16 + Turbopack loads `instrumentation.ts` in a SEPARATE module graph
 * from route handlers and RSC, so a plain module-scoped instance is a different
 * object in each graph. A tier that registers handlers only at boot (via
 * `instrumentation.ts` -> `initApp()`) would then be invisible on the request
 * path — and because `getCapabilityDefinitions()` filters out any slug the
 * in-process dispatcher does not hold, those tools are dropped from the agent's
 * toolset entirely rather than failing loudly at dispatch.
 *
 * Backing it with `globalThis` gives every graph the same instance, exactly as
 * `lib/db/client.ts` already does for the Prisma client. It also means the six
 * in-memory maps (handlers, guards, registry, rate limiters, agent bindings)
 * survive a dev hot-reload instead of silently resetting mid-session.
 */
const globalForDispatcher = globalThis as unknown as {
  sunriseCapabilityDispatcher?: CapabilityDispatcher;
};

export const capabilityDispatcher: CapabilityDispatcher =
  (globalForDispatcher.sunriseCapabilityDispatcher ??= new CapabilityDispatcher());

export type { CapabilityDispatcher };

/**
 * True when the subclass defines its own `redactProvenance` method
 * (rather than inheriting the passthrough default from `BaseCapability`).
 *
 * Used by `register()` to enforce that PII-handling capabilities
 * provide explicit redaction. Detection is via own-property check on
 * the instance's prototype — the inherited default lives on
 * `BaseCapability.prototype`, so a subclass that doesn't override
 * leaves no own property on its own prototype.
 */
function isRedactorOverridden(capability: BaseCapability): boolean {
  const proto = Object.getPrototypeOf(capability) as object;
  return Object.prototype.hasOwnProperty.call(proto, 'redactProvenance');
}
