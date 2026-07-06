/**
 * MCP Tool Registry
 *
 * Bridge between MCP tool requests and the capability dispatcher.
 * Lists enabled tools and dispatches calls through the full 9-step
 * capability pipeline.
 *
 * Platform-agnostic: no Next.js imports.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { capabilityFunctionDefinitionSchema } from '@/lib/validations/orchestration';
import type {
  McpToolDefinition,
  McpToolAnnotations,
  McpToolCallResult,
  McpContentBlock,
} from '@/types/mcp';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matching dispatcher

/** Slug of the system agent used for MCP tool calls */
const MCP_SYSTEM_AGENT_SLUG = 'mcp-system';

let cachedTools: McpToolDefinition[] | null = null;
let cachedAt = 0;
let mcpSystemAgentId: string | null = null;

/**
 * List MCP-exposed tools that are both enabled in McpExposedTool and active
 * in AiCapability.
 *
 * When `scopedAgentId` is set (the caller's API key is bound to an agent), the
 * list is filtered so it reflects what that key can actually invoke: tools
 * whose capability is **explicitly disabled** for the agent (an
 * `AiAgentCapability` row with `isEnabled = false`) are dropped, giving
 * list/call parity — `tools/call` already refuses those under the scoped agent
 * (see `callMcpTool` → dispatcher). Scoping is **default-allow**: a capability
 * with no binding row for the agent stays callable, so it stays listed;
 * scoping only honours explicit *disable* bindings, mirroring the dispatcher's
 * opt-out semantics. Unscoped keys (`scopedAgentId` null/undefined) get the
 * full global list, unchanged.
 *
 * The global list is cached (5-min TTL); the per-agent disable filter is a
 * small live query (`tools/list` is low-frequency and this keeps the filter
 * coherent with admin binding changes without a second cache to invalidate).
 */
export async function listMcpTools(scopedAgentId?: string | null): Promise<McpToolDefinition[]> {
  const tools = await loadGlobalTools();

  if (!scopedAgentId) return tools;

  const disabledSlugs = await getDisabledCapabilitySlugs(scopedAgentId);
  if (disabledSlugs.size === 0) return tools;

  return tools.filter((t) => !disabledSlugs.has(t.slug));
}

/** Build (or return the cached) global list of MCP-exposed, active tools. */
async function loadGlobalTools(): Promise<McpToolDefinition[]> {
  const now = Date.now();
  if (cachedTools && now - cachedAt < CACHE_TTL_MS) {
    return cachedTools;
  }

  const rows = await prisma.mcpExposedTool.findMany({
    where: { isEnabled: true },
    include: {
      capability: true,
    },
  });

  const tools: McpToolDefinition[] = [];

  for (const row of rows) {
    if (!row.capability.isActive) continue;

    const parsed = capabilityFunctionDefinitionSchema.safeParse(row.capability.functionDefinition);
    if (!parsed.success) {
      logger.warn('MCP tool registry: malformed functionDefinition, skipping', {
        capabilitySlug: row.capability.slug,
      });
      continue;
    }

    const annotations = buildAnnotations(row, row.capability.isIdempotent);

    tools.push({
      slug: row.capability.slug,
      name: row.customName ?? parsed.data.name,
      description: row.customDescription ?? parsed.data.description,
      inputSchema: parsed.data.parameters,
      ...(annotations ? { annotations } : {}),
    });
  }

  cachedTools = tools;
  cachedAt = Date.now();
  return tools;
}

/**
 * Capability slugs an agent has an **explicit** `isEnabled = false` binding
 * for. Missing rows are default-allow (not returned), matching the dispatcher's
 * opt-out `getAgentBinding` semantics.
 */
async function getDisabledCapabilitySlugs(agentId: string): Promise<Set<string>> {
  const rows = await prisma.aiAgentCapability.findMany({
    where: { agentId, isEnabled: false },
    select: { capability: { select: { slug: true } } },
  });
  return new Set(rows.map((r) => r.capability.slug));
}

/**
 * Resolve the MCP system agent ID (created by seed).
 * Returns null if the agent doesn't exist yet.
 */
async function getMcpSystemAgentId(): Promise<string | null> {
  if (mcpSystemAgentId) return mcpSystemAgentId;

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: MCP_SYSTEM_AGENT_SLUG },
    select: { id: true },
  });

  if (agent) {
    mcpSystemAgentId = agent.id;
  }
  return mcpSystemAgentId;
}

/**
 * Call an MCP tool by delegating to the capability dispatcher.
 *
 * Resolves the executing agent from the key's `scopedAgentId` when set —
 * so a scoped key's tool calls attribute cost/budget and scope knowledge-base
 * retrieval (`resolveAgentDocumentAccess`) to that agent, matching the MCP
 * resources path (`handleResourcesRead`). Falls back to the `mcp-system`
 * agent for unscoped keys, preserving prior behaviour. An optional `scope`
 * carrier is threaded through to `execute()` (see `CapabilityContext.scope`);
 * it is undefined until a caller supplies it.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  caller: { userId: string | null; scopedAgentId?: string | null; scope?: Record<string, string> }
): Promise<McpToolCallResult> {
  // Resolve the actual capability slug from tool name (custom names are
  // supported, so we look up by either). Resolve against the UNSCOPED global
  // list on purpose: a direct call to a tool disabled for the scoped agent
  // should reach the dispatcher and return `capability_disabled_for_agent`, not
  // a misleading "Unknown tool". `tools/list` hides it from discovery; dispatch
  // still enforces the disable.
  const tools = await listMcpTools();
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  // Honour the key's scoped agent when bound; otherwise fall back to the
  // shared mcp-system agent (which every backend caller can dispatch under).
  const agentId = caller.scopedAgentId ?? (await getMcpSystemAgentId());
  if (!agentId) {
    logger.error('MCP tool call: mcp-system agent not found — run db:seed');
    return {
      content: [{ type: 'text', text: 'MCP system agent not configured' }],
      isError: true,
    };
  }

  const context: CapabilityContext = {
    userId: caller.userId,
    agentId,
    ...(caller.scope ? { scope: caller.scope } : {}),
  };

  let result;
  try {
    result = await capabilityDispatcher.dispatch(tool.slug, args ?? {}, context);
  } catch (err) {
    logger.error('MCP tool call: dispatcher threw', {
      toolSlug: tool.slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      content: [{ type: 'text', text: 'Tool execution failed unexpectedly' }],
      isError: true,
    };
  }

  if (result.success) {
    // Two return shapes are accepted from capabilities:
    //  1) the legacy "any JSON" shape — wrap as a single text block.
    //  2) a `{ contentBlocks: [...] }` payload with rich blocks — pass
    //     through after validation + size caps.
    const data = result.data;
    if (isContentBlockArrayShape(data)) {
      const validated = validateAndCapBlocks(data.contentBlocks, tool.slug);
      if ('error' in validated) {
        return {
          content: [{ type: 'text', text: validated.error }],
          isError: true,
        };
      }
      return { content: validated.blocks };
    }
    const content: McpContentBlock[] = [{ type: 'text', text: JSON.stringify(data ?? {}) }];
    return { content };
  }

  return {
    content: [
      {
        type: 'text',
        text: result.error?.message ?? 'Tool execution failed',
      },
    ],
    isError: true,
  };
}

/** Clear the tool cache (after admin mutations) */
export function clearMcpToolCache(): void {
  cachedTools = null;
  cachedAt = 0;
  mcpSystemAgentId = null;
}

// ---------------------------------------------------------------------------
// Content-block caps for tool results (MCP 2025-06-18 image/audio/resource)
// ---------------------------------------------------------------------------

/** Max number of content blocks a single tool may return. */
const MAX_CONTENT_BLOCKS = 50;
/** Max per-block payload for image and audio blocks (decoded bytes). */
const MAX_BINARY_BLOCK_BYTES = 5 * 1024 * 1024;
/** Max total payload across all blocks (decoded bytes for binary, byte-length for text). */
const MAX_TOTAL_PAYLOAD_BYTES = 10 * 1024 * 1024;

/** Type-guard for the new `{ contentBlocks }` capability return shape. */
function isContentBlockArrayShape(data: unknown): data is { contentBlocks: unknown[] } {
  return (
    data !== null &&
    typeof data === 'object' &&
    'contentBlocks' in data &&
    Array.isArray((data as { contentBlocks?: unknown }).contentBlocks)
  );
}

/**
 * Validate a capability's returned content blocks against shape + size caps.
 *
 * Returns either the validated blocks or a generic error message. We
 * deliberately do NOT pass through the raw cap violation to clients (e.g.
 * "image is 7MB, cap is 5MB") — that would let a misbehaving capability
 * probe the cap values. The server-side log gets the specifics.
 */
function validateAndCapBlocks(
  raw: unknown[],
  toolSlug: string
): { blocks: McpContentBlock[] } | { error: string } {
  if (raw.length > MAX_CONTENT_BLOCKS) {
    logger.warn('MCP tool: content block count exceeded', {
      toolSlug,
      count: raw.length,
      cap: MAX_CONTENT_BLOCKS,
    });
    return { error: 'Tool returned too many content blocks.' };
  }

  const blocks: McpContentBlock[] = [];
  let totalBytes = 0;

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (r === null || typeof r !== 'object' || !('type' in r)) {
      logger.warn('MCP tool: malformed content block', { toolSlug, index: i });
      return { error: 'Tool returned a malformed content block.' };
    }
    const type = r.type;

    if (type === 'text') {
      const text = (r as { text?: unknown }).text;
      if (typeof text !== 'string') {
        return { error: 'Tool returned a malformed text block.' };
      }
      totalBytes += Buffer.byteLength(text, 'utf8');
      if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
        logger.warn('MCP tool: total payload size exceeded', { toolSlug, totalBytes });
        return { error: 'Tool response exceeds the total payload limit.' };
      }
      blocks.push({ type: 'text', text });
      continue;
    }

    if (type === 'image' || type === 'audio') {
      const { data, mimeType } = r as { data?: unknown; mimeType?: unknown };
      if (typeof data !== 'string' || typeof mimeType !== 'string') {
        return { error: `Tool returned a malformed ${type} block.` };
      }
      const decoded = decodeBase64Length(data);
      if (decoded === null) {
        return { error: `Tool returned an invalid base64 payload for a ${type} block.` };
      }
      if (decoded > MAX_BINARY_BLOCK_BYTES) {
        logger.warn('MCP tool: binary block size exceeded', {
          toolSlug,
          type,
          bytes: decoded,
          cap: MAX_BINARY_BLOCK_BYTES,
        });
        return { error: `Tool returned a ${type} block that exceeds the size limit.` };
      }
      totalBytes += decoded;
      if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
        logger.warn('MCP tool: total payload size exceeded', { toolSlug, totalBytes });
        return { error: 'Tool response exceeds the total payload limit.' };
      }
      blocks.push(
        type === 'image' ? { type: 'image', data, mimeType } : { type: 'audio', data, mimeType }
      );
      continue;
    }

    if (type === 'resource') {
      const resource = (r as { resource?: unknown }).resource;
      if (resource === null || typeof resource !== 'object') {
        return { error: 'Tool returned a malformed embedded resource block.' };
      }
      const { uri, mimeType, text, blob } = resource as {
        uri?: unknown;
        mimeType?: unknown;
        text?: unknown;
        blob?: unknown;
      };
      if (typeof uri !== 'string' || typeof mimeType !== 'string') {
        return { error: 'Embedded resource missing uri or mimeType.' };
      }
      // text and blob are mutually exclusive per spec — exactly one must be set.
      if (typeof text === 'string' && typeof blob === 'string') {
        return { error: 'Embedded resource must have exactly one of text or blob.' };
      }
      if (typeof text === 'string') {
        totalBytes += Buffer.byteLength(text, 'utf8');
        if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
          return { error: 'Tool response exceeds the total payload limit.' };
        }
        blocks.push({ type: 'resource', resource: { uri, mimeType, text } });
      } else if (typeof blob === 'string') {
        const decoded = decodeBase64Length(blob);
        if (decoded === null) {
          return { error: 'Embedded resource has invalid base64 blob.' };
        }
        if (decoded > MAX_BINARY_BLOCK_BYTES) {
          return { error: 'Embedded resource blob exceeds the size limit.' };
        }
        totalBytes += decoded;
        if (totalBytes > MAX_TOTAL_PAYLOAD_BYTES) {
          return { error: 'Tool response exceeds the total payload limit.' };
        }
        blocks.push({ type: 'resource', resource: { uri, mimeType, blob } });
      } else {
        return { error: 'Embedded resource must have exactly one of text or blob.' };
      }
      continue;
    }

    return { error: `Tool returned an unknown content block type: ${String(type)}` };
  }

  return { blocks };
}

/**
 * Compute the byte length of a base64-encoded string. Returns null when the
 * input is not valid base64 (handles standard + url-safe variants and
 * tolerates whitespace).
 *
 * We don't actually decode (the bytes aren't needed) — we just compute the
 * length from the padded form, which avoids allocating the entire buffer
 * for a 5 MB image just to length-check it.
 */
function decodeBase64Length(input: string): number | null {
  // Strip whitespace; allow standard + url-safe.
  const normalised = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalised)) return null;
  if (normalised.length % 4 !== 0) return null;
  let bytes = (normalised.length / 4) * 3;
  if (normalised.endsWith('==')) bytes -= 2;
  else if (normalised.endsWith('=')) bytes -= 1;
  return bytes;
}

/**
 * Build the MCP tool annotations object from the McpExposedTool row.
 *
 * Per-exposure overrides win over capability-level defaults. `idempotentHint`
 * specifically: a non-null override on the row replaces `capability.isIdempotent`;
 * a null row value means "inherit the capability". This lets the same
 * capability behave differently when called via MCP vs. internally — e.g.
 * a capability that's idempotent internally but routes through an
 * external service that doesn't deduplicate on the MCP path.
 *
 * Returns `undefined` (not `{}`) when no annotations apply, so the registry
 * can use a spread-conditional to omit the key entirely.
 */
function buildAnnotations(
  row: {
    customTitle: string | null;
    readOnlyHint: boolean | null;
    destructiveHint: boolean | null;
    idempotentHint: boolean | null;
    openWorldHint: boolean | null;
  },
  capabilityIsIdempotent: boolean
): McpToolAnnotations | undefined {
  const annotations: McpToolAnnotations = {};
  if (row.customTitle) annotations.title = row.customTitle;
  if (row.readOnlyHint !== null) annotations.readOnlyHint = row.readOnlyHint;
  if (row.destructiveHint !== null) annotations.destructiveHint = row.destructiveHint;
  // Inherit capability.isIdempotent only when the override is null.
  const effectiveIdempotent =
    row.idempotentHint !== null ? row.idempotentHint : capabilityIsIdempotent;
  // Only emit if it's a meaningful signal (true) or an explicit "no" (false)
  // from the row. Don't emit a capability-inherited true unless the
  // capability actually marked itself idempotent.
  if (row.idempotentHint !== null) {
    annotations.idempotentHint = row.idempotentHint;
  } else if (effectiveIdempotent) {
    annotations.idempotentHint = true;
  }
  if (row.openWorldHint !== null) annotations.openWorldHint = row.openWorldHint;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}
