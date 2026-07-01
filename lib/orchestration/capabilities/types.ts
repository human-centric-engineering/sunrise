/**
 * Capability types
 *
 * Shared type definitions for the capability dispatcher. Pure types —
 * no runtime, no Next.js imports.
 */

import type { ZodType } from 'zod';

/**
 * Uniform result shape returned by every capability execution. The
 * chat handler translates this into a `ChatEvent` of type
 * `capability_result` (see `types/orchestration.ts`).
 */
export interface CapabilityResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  /**
   * When true, the chat handler should NOT feed this result back to
   * the LLM for a follow-up turn. Set this when the result already
   * contains the final answer the user asked for (e.g. a cost
   * estimate), so we skip a wasteful second round-trip.
   */
  skipFollowup?: boolean;
  /** Additional structured data (e.g. approval timeout config). */
  metadata?: Record<string, unknown>;
}

/**
 * Execution context supplied by the caller (usually the chat handler
 * or an admin API route). Capabilities should treat this as read-only.
 */
export interface CapabilityContext {
  userId: string | null;
  agentId: string;
  conversationId?: string;
  /**
   * Free-form context from the chat handler (e.g. the current entity
   * being discussed). Capabilities can inspect but shouldn't require
   * it.
   */
  entityContext?: Record<string, unknown>;
  /**
   * Optional free-form scope map populated by the dispatcher's caller.
   * Generic by design — core names no keys and no core capability reads
   * it; it is purely a carrier threaded through to `execute()`.
   * Downstream consumers read well-known keys (e.g. a module slug) so a
   * capability can refuse to run outside its intended scope. Vanilla
   * behaviour is unchanged when `scope` is undefined.
   */
  scope?: Record<string, string>;
}

/**
 * Shape stored in `AiCapability.functionDefinition` (JSON column).
 * Mirrors the OpenAI function-calling schema so it can be passed
 * straight through to any OpenAI-compatible provider.
 */
export interface CapabilityFunctionDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/**
 * Metadata loaded by the dispatcher from the `AiCapability` table.
 */
export interface CapabilityRegistryEntry {
  id: string;
  slug: string;
  name: string;
  category: string;
  functionDefinition: CapabilityFunctionDefinition;
  requiresApproval: boolean;
  /** Per-capability approval timeout in ms; null = use global default. */
  approvalTimeoutMs: number | null;
  /** Calls per minute; null = unlimited. */
  rateLimit: number | null;
  /**
   * True when the capability is naturally safe to re-run — destination handles
   * duplicates (pure read, upsert keyed on stable input). The engine's
   * `tool_call` executor skips the dispatch cache for these, avoiding a DB
   * write per call. Default false: assume side effects until the author opts in.
   */
  isIdempotent: boolean;
  isActive: boolean;
  /**
   * Emergency-disable state. Distinct from `isActive`: `quarantineState`
   * is reserved for incident response (a vendor API misbehaving, a tool
   * returning wrong data), while `isActive` is the routine on/off switch.
   * The dispatcher returns `capability_quarantined` with `mode` + `reason`
   * in metadata so agents can react. `quarantineUntil` is checked at read
   * time — a past timestamp is treated as `active`.
   */
  quarantineState: QuarantineState;
  quarantineReason: string | null;
  quarantineUntil: Date | null;
}

/** Capability quarantine state. See `CapabilityRegistryEntry.quarantineState`. */
export type QuarantineState = 'active' | 'quarantined-soft' | 'quarantined-hard';

/**
 * Per-agent capability binding — merged view of `AiAgentCapability`
 * (pivot) + `AiCapability` (base config).
 */
export interface AgentCapabilityBinding {
  slug: string;
  isEnabled: boolean;
  /** `customRateLimit ?? rateLimit` from the underlying capability. */
  effectiveRateLimit: number | null;
  functionDefinition: CapabilityFunctionDefinition;
  requiresApproval: boolean;
}

/** Convenience alias for the Zod schema a capability uses to validate its args. */
export type CapabilitySchema<TArgs> = ZodType<TArgs>;
