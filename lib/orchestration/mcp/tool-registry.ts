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
import type { McpToolDefinition, McpToolCallResult, McpContentBlock } from '@/types/mcp';
import type { CapabilityContext } from '@/lib/orchestration/capabilities/types';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes, matching dispatcher

/** Slug of the system agent used for MCP tool calls */
const MCP_SYSTEM_AGENT_SLUG = 'mcp-system';

let cachedTools: McpToolDefinition[] | null = null;
let cachedAt = 0;
let mcpSystemAgentId: string | null = null;

/**
 * List all MCP-exposed tools that are both enabled in McpExposedTool
 * and active in AiCapability.
 */
export async function listMcpTools(): Promise<McpToolDefinition[]> {
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

    tools.push({
      slug: row.capability.slug,
      name: row.customName ?? parsed.data.name,
      description: row.customDescription ?? parsed.data.description,
      inputSchema: parsed.data.parameters,
    });
  }

  cachedTools = tools;
  cachedAt = Date.now();
  return tools;
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
 * Creates a synthetic CapabilityContext with the mcp-system agent
 * and translates the CapabilityResult to MCP content blocks.
 */
export async function callMcpTool(
  toolName: string,
  args: Record<string, unknown> | undefined,
  userId: string
): Promise<McpToolCallResult> {
  // Resolve the actual capability slug from tool name
  // (custom names are supported, so we need to look up by either)
  const tools = await listMcpTools();
  const tool = tools.find((t) => t.name === toolName);

  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
      isError: true,
    };
  }

  const agentId = await getMcpSystemAgentId();
  if (!agentId) {
    logger.error('MCP tool call: mcp-system agent not found — run db:seed');
    return {
      content: [{ type: 'text', text: 'MCP system agent not configured' }],
      isError: true,
    };
  }

  const context: CapabilityContext = {
    userId,
    agentId,
  };

  const result = await capabilityDispatcher.dispatch(tool.slug, args ?? {}, context);

  if (result.success) {
    const content: McpContentBlock[] = [{ type: 'text', text: JSON.stringify(result.data ?? {}) }];
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
