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
}

/**
 * Execution context supplied by the caller (usually the chat handler
 * or an admin API route). Capabilities should treat this as read-only.
 */
export interface CapabilityContext {
  userId: string;
  agentId: string;
  conversationId?: string;
  /**
   * Free-form context from the chat handler (e.g. the current entity
   * being discussed). Capabilities can inspect but shouldn't require
   * it.
   */
  entityContext?: Record<string, unknown>;
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
  /** Calls per minute; null = unlimited. */
  rateLimit: number | null;
  isActive: boolean;
}

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
