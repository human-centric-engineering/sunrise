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
  CapabilityRegistryEntry,
  CapabilityResult,
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

/** Cache lifetime for both the registry and per-agent bindings. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60_000;

class CapabilityDispatcher {
  private handlers = new Map<string, BaseCapability>();
  private registry = new Map<string, CapabilityRegistryEntry>();
  private rateLimiters = new Map<string, RateLimiter>();
  private agentBindings = new Map<string, Map<string, AgentCapabilityBinding>>();

  private registryFetchedAt = 0;
  private inflightLoad: Promise<void> | null = null;
  private agentBindingsFetchedAt = new Map<string, number>();
  private inflightBindingLoads = new Map<string, Promise<void>>();

  /**
   * Register an in-memory capability handler. Idempotent: re-registering
   * the same slug replaces the previous handler.
   */
  register(capability: BaseCapability): void {
    this.handlers.set(capability.slug, capability);
  }

  has(slug: string): boolean {
    return this.handlers.has(slug);
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

    // 4. Per-agent binding. Missing pivot rows fall through to the
    //    defaults from the base capability — the admin UI uses opt-out
    //    semantics.
    const binding = await this.getAgentBinding(context.agentId, slug, entry);
    if (binding && binding.isEnabled === false) {
      logger.warn('Capability dispatch: disabled for agent', {
        slug,
        agentId: context.agentId,
      });
      return {
        success: false,
        error: {
          code: 'capability_disabled_for_agent',
          message: `Capability ${slug} is disabled for agent ${context.agentId}`,
        },
      };
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
        [SUNRISE_USER_ID]: context.userId,
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
        let result: CapabilityResult;
        try {
          result = await handler.execute(validated, context);
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
        void logCost({
          ...(context.agentId ? { agentId: context.agentId } : {}),
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
   */
  private async getAgentBinding(
    agentId: string,
    slug: string,
    entry: CapabilityRegistryEntry
  ): Promise<AgentCapabilityBinding | null> {
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

    // No explicit row → synthesize a default-allow binding from the
    // base capability entry.
    return {
      slug,
      isEnabled: true,
      effectiveRateLimit: entry.rateLimit,
      functionDefinition: entry.functionDefinition,
      requiresApproval: entry.requiresApproval,
    };
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
  };
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
      const message = String((issue as { message: unknown }).message);
      return path ? `${path}: ${message}` : message;
    }
    return String(issue);
  });
  return parts.join('; ');
}

/** Module-level singleton, matching `providerManager` style. */
export const capabilityDispatcher = new CapabilityDispatcher();

export type { CapabilityDispatcher };
