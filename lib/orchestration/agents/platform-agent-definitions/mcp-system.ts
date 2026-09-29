/**
 * MCP System — the execution identity the MCP server dispatches external
 * clients' tool calls as. It never holds a conversation, and it has no
 * bindings of its own: the tools an MCP client may call are chosen on the MCP
 * Server → Tools page, not here.
 */
import type { PlatformAgentDefinition } from '@/lib/orchestration/agents/platform-agents';

export const MCP_SYSTEM_AGENT: PlatformAgentDefinition = {
  slug: 'mcp-system',
  audience: 'every-org',
  agent: {
    name: 'MCP System',
    description:
      'System agent — do not edit. Used internally by the MCP server as the execution identity when external AI clients (Claude Desktop, Cursor, etc.) call tools. To expose capabilities to MCP clients, use the MCP Server → Tools page instead of assigning capabilities here.',
    systemInstructions:
      'You are the MCP system agent. You dispatch tool calls on behalf of external MCP clients. This agent never participates in LLM conversations — it exists solely as the execution identity for capability pipeline dispatch.',
    temperature: 0,
    maxTokens: 4096,
  },
  capabilities: [],
  knowledgeTags: [],
};
