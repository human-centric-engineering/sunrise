/**
 * MCP completion registry
 *
 * Implements `completion/complete` per MCP 2025-06-18: clients ask for
 * autocomplete candidates for a prompt argument or a resource URI
 * template variable, given a partial value.
 *
 * Hard rule: completion lookups are **purely static** — no tool
 * invocation, no LLM call, no resource read. This bounds the cost of an
 * autocomplete keystroke and prevents accidental recursion (a completion
 * lookup that ends up triggering another tool that triggers another
 * completion lookup…). The shape that ships first is admin-supplied
 * candidate lists stored on the prompt / resource row.
 *
 * The pattern_detail resource gets a special case (1–21 enumerated
 * dynamically) since it's a fixed-cardinality registry that admins
 * shouldn't have to keep in sync.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import type { Prisma } from '@prisma/client';

/** Max candidates returned to the client per request. */
export const MAX_COMPLETION_CANDIDATES = 100;

/** Max admin-supplied candidates per argument. */
export const MAX_STORED_CANDIDATES_PER_ARG = 500;

/** Max partial value length we'll consider. */
export const MAX_PARTIAL_LENGTH = 1024;

/** Reference shape per MCP spec. */
export type McpCompletionRef =
  { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string };

export interface McpCompletionResult {
  completion: {
    values: string[];
    /** True when there are more matches than `values` returned. */
    hasMore: boolean;
    /** Total number of matches (capped at the stored max). */
    total: number;
  };
}

/**
 * Look up completion candidates for a prompt argument or resource template
 * variable, prefix-filtered by `partial`.
 *
 * Returns `null` when the ref / argument combination is not configured
 * for completions — the protocol handler maps null to an empty-completion
 * response so clients see "no suggestions" rather than an error.
 */
export async function completeMcpReference(
  ref: McpCompletionRef,
  argumentName: string,
  partial: string
): Promise<McpCompletionResult> {
  if (partial.length > MAX_PARTIAL_LENGTH) {
    throw new RangeError(`argument value exceeds ${String(MAX_PARTIAL_LENGTH)} char limit`);
  }

  const allCandidates = await loadCandidates(ref, argumentName);
  const filtered = filterByPrefix(allCandidates, partial);
  const limited = filtered.slice(0, MAX_COMPLETION_CANDIDATES);
  return {
    completion: {
      values: limited,
      hasMore: filtered.length > limited.length,
      total: filtered.length,
    },
  };
}

async function loadCandidates(
  ref: McpCompletionRef,
  argumentName: string
): Promise<readonly string[]> {
  if (ref.type === 'ref/prompt') {
    const row = await prisma.mcpExposedPrompt.findUnique({
      where: { name: ref.name },
      select: { completionsSpec: true },
    });
    if (!row) return [];
    return readCandidates(row.completionsSpec, argumentName);
  }

  // ref/resource — special-case the patterns 1–21 enumeration since they
  // never change and admins shouldn't have to maintain a hardcoded list.
  if (ref.uri.startsWith('sunrise://knowledge/patterns/') && argumentName === 'number') {
    return Array.from({ length: 21 }, (_, i) => String(i + 1));
  }

  // Otherwise pull `completionsSpec[argName]` from the resource row's
  // handlerConfig.
  const row = await prisma.mcpExposedResource.findUnique({
    where: { uri: ref.uri },
    select: { handlerConfig: true },
  });
  if (!row?.handlerConfig) return [];
  const spec = readCompletionsSpec(row.handlerConfig);
  return readCandidates(spec, argumentName);
}

/**
 * Pull `completionsSpec` out of a resource's handlerConfig JSON blob. Tolerant
 * of admins who haven't set it (returns null → empty list at the caller).
 */
function readCompletionsSpec(handlerConfig: Prisma.JsonValue): Prisma.JsonValue | null {
  if (handlerConfig === null || typeof handlerConfig !== 'object' || Array.isArray(handlerConfig)) {
    return null;
  }
  const spec = (handlerConfig as Record<string, unknown>).completionsSpec;
  return spec ?? null;
}

/**
 * Narrow + read `spec[argName]` as an array of strings. Defensively skips
 * non-string entries and caps the returned list at MAX_STORED_CANDIDATES.
 */
function readCandidates(spec: Prisma.JsonValue | null, argumentName: string): readonly string[] {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return [];
  const list = (spec as Record<string, unknown>)[argumentName];
  if (!Array.isArray(list)) return [];
  const strings = list.filter((s): s is string => typeof s === 'string');
  return strings.slice(0, MAX_STORED_CANDIDATES_PER_ARG);
}

function filterByPrefix(candidates: readonly string[], partial: string): string[] {
  if (partial === '') return [...candidates];
  const lower = partial.toLowerCase();
  return candidates.filter((c) => c.toLowerCase().startsWith(lower));
}
