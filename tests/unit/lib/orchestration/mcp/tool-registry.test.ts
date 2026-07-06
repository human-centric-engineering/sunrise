import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedTool: {
      findMany: vi.fn(),
    },
    aiAgent: {
      findUnique: vi.fn(),
    },
    aiAgentCapability: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/orchestration/capabilities/dispatcher', () => ({
  capabilityDispatcher: {
    dispatch: vi.fn(),
  },
}));

vi.mock('@/lib/validations/orchestration', () => ({
  capabilityFunctionDefinitionSchema: {
    safeParse: vi.fn(),
  },
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import { capabilityFunctionDefinitionSchema } from '@/lib/validations/orchestration';
import {
  listMcpTools,
  callMcpTool,
  clearMcpToolCache,
} from '@/lib/orchestration/mcp/tool-registry';
import type { McpContentBlock } from '@/types/mcp';

/**
 * Narrow a content block to text so assertions like `.text` are sound under
 * the new discriminated-union shape. Throws clearly when the wrong block
 * type was returned.
 */
function asText(block: McpContentBlock): string {
  if (block.type !== 'text') {
    throw new Error(`Expected text block, got ${block.type}`);
  }
  return block.text;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapability(
  overrides: Partial<{
    slug: string;
    isActive: boolean;
    isIdempotent: boolean;
    functionDefinition: unknown;
  }> = {}
) {
  return {
    id: 'cap-1',
    slug: 'search_knowledge',
    isActive: true,
    isIdempotent: false,
    functionDefinition: {
      name: 'search_knowledge',
      description: 'Search the knowledge base',
      parameters: { type: 'object', properties: {} },
    },
    ...overrides,
  };
}

function makeExposedTool(
  overrides: Partial<{
    id: string;
    customName: string | null;
    customDescription: string | null;
    isEnabled: boolean;
    customTitle: string | null;
    readOnlyHint: boolean | null;
    destructiveHint: boolean | null;
    idempotentHint: boolean | null;
    openWorldHint: boolean | null;
    capability: ReturnType<typeof makeCapability>;
  }> = {}
) {
  return {
    id: 'tool-1',
    capabilityId: 'cap-1',
    isEnabled: true,
    customName: null,
    customDescription: null,
    rateLimitPerKey: null,
    requiresScope: null,
    // MCP 2025-06-18 tool annotation overrides — all null = "inherit / no opinion"
    customTitle: null as string | null,
    readOnlyHint: null as boolean | null,
    destructiveHint: null as boolean | null,
    idempotentHint: null as boolean | null,
    openWorldHint: null as boolean | null,
    capability: makeCapability(),
    ...overrides,
  };
}

function makeSuccessfulParse(name = 'search_knowledge', description = 'Search the knowledge base') {
  return {
    success: true,
    data: {
      name,
      description,
      parameters: { type: 'object', properties: {} },
    },
  };
}

// ---------------------------------------------------------------------------
// listMcpTools
// ---------------------------------------------------------------------------

describe('listMcpTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpToolCache();
  });

  it('queries mcpExposedTool with isEnabled filter and capability include', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);

    await listMcpTools();

    expect(prisma.mcpExposedTool.findMany).toHaveBeenCalledWith({
      where: { isEnabled: true },
      include: { capability: true },
    });
  });

  it('returns an empty array when no tools are found', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);

    const result = await listMcpTools();
    expect(result).toEqual([]);
  });

  it('maps enabled active tools to McpToolDefinition shape', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const result = await listMcpTools();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slug: 'search_knowledge',
      name: 'search_knowledge',
      description: 'Search the knowledge base',
      inputSchema: { type: 'object', properties: {} },
    });
  });

  it('uses customName when provided', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({ customName: 'kb_search' }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const result = await listMcpTools();
    expect(result[0].name).toBe('kb_search');
  });

  it('uses customDescription when provided', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({ customDescription: 'Custom description override' }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const result = await listMcpTools();
    expect(result[0].description).toBe('Custom description override');
  });

  it('skips tools whose capability is not active', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({ capability: makeCapability({ isActive: false }) }),
    ] as never);

    const result = await listMcpTools();
    expect(result).toHaveLength(0);
    // safeParse should never be called for inactive capabilities
    // test-review:accept clear_then_notcalled — clearAllMocks is in beforeEach (not mid-test); not.toHaveBeenCalled verifies inactive capability skipped safeParse
    expect(capabilityFunctionDefinitionSchema.safeParse).not.toHaveBeenCalled();
  });

  it('skips tools with malformed functionDefinition and warns', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue({
      success: false,
      error: { issues: [] },
    } as never);

    const result = await listMcpTools();
    expect(result).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('malformed functionDefinition'),
      expect.objectContaining({ capabilitySlug: 'search_knowledge' })
    );
  });

  it('caches results on second call within TTL', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);

    await listMcpTools();
    await listMcpTools();

    expect(prisma.mcpExposedTool.findMany).toHaveBeenCalledOnce();
  });

  it('re-fetches after clearMcpToolCache', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);

    await listMcpTools();
    clearMcpToolCache();
    await listMcpTools();

    expect(prisma.mcpExposedTool.findMany).toHaveBeenCalledTimes(2);
  });

  it('handles multiple tools, filtering out inactive ones', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({
        id: 'tool-1',
        capability: makeCapability({ slug: 'tool_a', isActive: true }),
      }),
      makeExposedTool({
        id: 'tool-2',
        capability: makeCapability({ slug: 'tool_b', isActive: false }),
      }),
      makeExposedTool({
        id: 'tool-3',
        capability: makeCapability({ slug: 'tool_c', isActive: true }),
      }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse)
      .mockReturnValueOnce(makeSuccessfulParse('tool_a', 'Tool A') as never)
      .mockReturnValueOnce(makeSuccessfulParse('tool_c', 'Tool C') as never);

    const result = await listMcpTools();
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.slug)).toEqual(['tool_a', 'tool_c']);
  });

  it('propagates DB errors when findMany rejects', async () => {
    // Arrange: simulate a database failure
    vi.mocked(prisma.mcpExposedTool.findMany).mockRejectedValue(
      new Error('Connection terminated unexpectedly')
    );

    // Act + Assert: the source does not catch DB errors, so it propagates
    await expect(listMcpTools()).rejects.toThrow('Connection terminated unexpectedly');
  });
});

// ---------------------------------------------------------------------------
// listMcpTools — agent-scoped filtering (#381)
// ---------------------------------------------------------------------------

describe('listMcpTools: agent scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpToolCache();
  });

  /** Two active exposed tools with distinct slugs (search_knowledge, send_email). */
  function twoTools(): void {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({ capability: makeCapability({ slug: 'search_knowledge' }) }),
      makeExposedTool({
        id: 'tool-2',
        capability: makeCapability({ slug: 'send_email' }),
      }),
    ] as never);
    // safeParse is called per row; return a valid parse each time.
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
  }

  it('does not consult agent bindings for an unscoped call', async () => {
    twoTools();

    const result = await listMcpTools();

    expect(result.map((t) => t.slug)).toEqual(['search_knowledge', 'send_email']);
    expect(prisma.aiAgentCapability.findMany).not.toHaveBeenCalled();
  });

  it('does not consult agent bindings when scopedAgentId is null', async () => {
    twoTools();

    await listMcpTools(null);

    expect(prisma.aiAgentCapability.findMany).not.toHaveBeenCalled();
  });

  it('drops tools explicitly disabled for the scoped agent (list/call parity)', async () => {
    twoTools();
    // `send_email` has an isEnabled=false binding for this agent.
    vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([
      { capability: { slug: 'send_email' } },
    ] as never);

    const result = await listMcpTools('agent-42');

    expect(result.map((t) => t.slug)).toEqual(['search_knowledge']);
    // Queries only the explicit-disable rows for that agent (default-allow).
    expect(prisma.aiAgentCapability.findMany).toHaveBeenCalledWith({
      where: { agentId: 'agent-42', isEnabled: false },
      select: { capability: { select: { slug: true } } },
    });
  });

  it('returns the full list when the scoped agent has no disable bindings (default-allow)', async () => {
    twoTools();
    vi.mocked(prisma.aiAgentCapability.findMany).mockResolvedValue([] as never);

    const result = await listMcpTools('agent-42');

    expect(result.map((t) => t.slug)).toEqual(['search_knowledge', 'send_email']);
  });
});

// ---------------------------------------------------------------------------
// callMcpTool
// ---------------------------------------------------------------------------

describe('callMcpTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpToolCache();
  });

  it('returns isError=true for an unknown tool name', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);

    const result = await callMcpTool('nonexistent_tool', {}, { userId: 'user-1' });

    // test-review:accept tobe_true — boolean field isError on McpToolCallResult; structural assertion on MCP error contract
    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toContain('Unknown tool');
  });

  it('returns isError=true when mcp-system agent is not found', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({ customName: 'search_knowledge' }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    // test-review:accept tobe_true — boolean field isError on McpToolCallResult; structural assertion on MCP error contract
    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toContain('MCP system agent');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('mcp-system agent not found')
    );
  });

  it('dispatches to capabilityDispatcher with correct context on success', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-42' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: { answer: 'result' },
    });

    const result = await callMcpTool('search_knowledge', { query: 'test' }, { userId: 'user-1' });

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge',
      { query: 'test' },
      { userId: 'user-1', agentId: 'agent-42' }
    );
    expect(result.isError).toBeUndefined();
    expect(asText(result.content[0])).toContain('answer');
  });

  it('serializes result data as JSON in content block', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data: { key: 'value', count: 42 },
    });

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    const parsed = JSON.parse(asText(result.content[0]));
    expect(parsed).toEqual({ key: 'value', count: 42 });
  });

  it('returns isError=true when dispatcher fails', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: false,
      error: { code: 'EXECUTION_FAILED', message: 'Something broke' },
    });

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    // test-review:accept tobe_true — boolean field isError on McpToolCallResult; structural assertion on MCP error contract
    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toBe('Something broke');
  });

  it('uses fallback message when dispatcher error has no message', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: false,
    });

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    // test-review:accept tobe_true — boolean field isError on McpToolCallResult; structural assertion on MCP error contract
    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toBe('Tool execution failed');
  });

  it('catches dispatcher exceptions and returns MCP error content', async () => {
    // Arrange: dispatcher throws instead of returning a failure result
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockRejectedValue(
      new Error('Dispatcher internal error')
    );

    // Act: callMcpTool catches the throw and returns an error content block
    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });
    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toBe('Tool execution failed unexpectedly');
  });

  it('passes empty object when args is undefined', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });

    await callMcpTool('search_knowledge', undefined, { userId: 'user-1' });

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge',
      {},
      expect.any(Object)
    );
  });

  it('caches the agent ID after first successful lookup (without clearing cache)', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-cached' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });

    // Two calls without clearing cache — agent lookup should fire only once
    await callMcpTool('search_knowledge', {}, { userId: 'user-1' });
    await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledOnce();
  });

  it('clearMcpToolCache resets the cached agent ID', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });

    await callMcpTool('search_knowledge', {}, { userId: 'user-1' });
    clearMcpToolCache();

    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledTimes(2);
  });

  it('resolves agent by slug mcp-system', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-sys' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });

    await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'mcp-system' } })
    );
  });
});

// ---------------------------------------------------------------------------
// callMcpTool: scoped agent + scope carrier (issue #375)
// ---------------------------------------------------------------------------

describe('callMcpTool: scoped agent resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpToolCache();
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });
  });

  it("dispatches under the key's scopedAgentId when bound, without a mcp-system lookup", async () => {
    // A scoped key must run its tool calls under its own agent so cost/budget
    // and knowledge-base grants resolve to that agent — matching the resources
    // path. The mcp-system fallback must NOT be consulted.
    await callMcpTool(
      'search_knowledge',
      { query: 'x' },
      {
        userId: 'user-1',
        scopedAgentId: 'agent-scoped',
      }
    );

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge',
      { query: 'x' },
      { userId: 'user-1', agentId: 'agent-scoped' }
    );
    expect(prisma.aiAgent.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to the mcp-system agent when scopedAgentId is null', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-sys' } as never);

    await callMcpTool('search_knowledge', {}, { userId: 'user-1', scopedAgentId: null });

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'mcp-system' } })
    );
    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge',
      {},
      { userId: 'user-1', agentId: 'agent-sys' }
    );
  });

  it('threads the scope carrier into the dispatch context when supplied', async () => {
    await callMcpTool(
      'search_knowledge',
      {},
      {
        userId: 'user-1',
        scopedAgentId: 'agent-scoped',
        scope: { projectId: 'proj-42' },
      }
    );

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge',
      {},
      { userId: 'user-1', agentId: 'agent-scoped', scope: { projectId: 'proj-42' } }
    );
  });

  it('omits the scope key entirely when no scope is supplied (vanilla context unchanged)', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-sys' } as never);

    await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    const [, , context] = vi.mocked(capabilityDispatcher.dispatch).mock.calls[0];
    expect(context).not.toHaveProperty('scope');
    expect(context).toEqual({ userId: 'user-1', agentId: 'agent-sys' });
  });
});

// ---------------------------------------------------------------------------
// clearMcpToolCache
// ---------------------------------------------------------------------------

describe('clearMcpToolCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpToolCache();
  });

  it('forces a fresh DB read on the next listMcpTools call', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([]);

    await listMcpTools();
    clearMcpToolCache();
    await listMcpTools();

    expect(prisma.mcpExposedTool.findMany).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tool annotations (MCP 2025-06-18)
// ---------------------------------------------------------------------------

describe('listMcpTools annotations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpToolCache();
  });

  it('omits the annotations object when no overrides are set and capability is not idempotent', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const tools = await listMcpTools();
    expect(tools[0].annotations).toBeUndefined();
  });

  it('emits annotations when any override is set', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({ readOnlyHint: true, customTitle: 'Search KB' }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const tools = await listMcpTools();
    expect(tools[0].annotations).toEqual({
      title: 'Search KB',
      readOnlyHint: true,
    });
  });

  it('inherits idempotentHint from capability.isIdempotent when override is null', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({
        capability: makeCapability({ isIdempotent: true }),
      }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const tools = await listMcpTools();
    expect(tools[0].annotations?.idempotentHint).toBe(true);
  });

  it('row override of idempotentHint:false beats capability default of true', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({
        idempotentHint: false,
        capability: makeCapability({ isIdempotent: true }),
      }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const tools = await listMcpTools();
    expect(tools[0].annotations?.idempotentHint).toBe(false);
  });

  it('emits destructiveHint and openWorldHint when set', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );

    const tools = await listMcpTools();
    expect(tools[0].annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Rich tool content blocks (MCP 2025-06-18 image/audio/resource)
// ---------------------------------------------------------------------------

describe('callMcpTool: rich content blocks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpToolCache();
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-42' } as never);
  });

  function mkPayload(blocks: unknown[]): { contentBlocks: unknown[] } {
    return { contentBlocks: blocks };
  }

  function mockDispatch(data: unknown): void {
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({
      success: true,
      data,
    });
  }

  it('passes through a multi-text payload', async () => {
    mockDispatch(
      mkPayload([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ])
    );

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(asText(result.content[0])).toBe('first');
    expect(asText(result.content[1])).toBe('second');
  });

  it('passes through an image block with valid base64', async () => {
    const tinyPng = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    mockDispatch(mkPayload([{ type: 'image', data: tinyPng, mimeType: 'image/png' }]));

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('image');
  });

  it('rejects invalid base64 in image block', async () => {
    mockDispatch(mkPayload([{ type: 'image', data: 'not!base64!', mimeType: 'image/png' }]));

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toContain('invalid base64');
  });

  it('rejects an image block larger than 5 MB', async () => {
    // 6 MB of base64 → ~4.5 MB decoded… use a larger source to clearly exceed.
    const big = 'A'.repeat(7 * 1024 * 1024); // ~5.25 MB decoded
    mockDispatch(mkPayload([{ type: 'image', data: big, mimeType: 'image/png' }]));

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toContain('size limit');
  });

  it('rejects when total payload exceeds 10 MB', async () => {
    // 3 binary blocks of 4 MB each (3 * 4 MB = 12 MB)
    const fourMB = 'A'.repeat(Math.ceil((4 * 1024 * 1024 * 4) / 3)); // ~4 MB decoded
    mockDispatch(
      mkPayload([
        { type: 'image', data: fourMB, mimeType: 'image/png' },
        { type: 'image', data: fourMB, mimeType: 'image/png' },
        { type: 'image', data: fourMB, mimeType: 'image/png' },
      ])
    );

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBe(true);
  });

  it('rejects more than 50 content blocks', async () => {
    const blocks = Array.from({ length: 51 }, (_, i) => ({
      type: 'text',
      text: `block ${String(i)}`,
    }));
    mockDispatch(mkPayload(blocks));

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toContain('too many');
  });

  it('rejects an embedded resource missing both text and blob', async () => {
    mockDispatch(
      mkPayload([{ type: 'resource', resource: { uri: 'sunrise://x', mimeType: 'text/plain' } }])
    );

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toContain('exactly one');
  });

  it('rejects an embedded resource with both text and blob', async () => {
    mockDispatch(
      mkPayload([
        {
          type: 'resource',
          resource: {
            uri: 'sunrise://x',
            mimeType: 'text/plain',
            text: 'hello',
            blob: Buffer.from('hi').toString('base64'),
          },
        },
      ])
    );

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBe(true);
  });

  it('passes through an embedded text resource', async () => {
    mockDispatch(
      mkPayload([
        {
          type: 'resource',
          resource: { uri: 'sunrise://docs/x', mimeType: 'text/markdown', text: '# Title' },
        },
      ])
    );

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('resource');
  });

  it('rejects an unknown content block type', async () => {
    mockDispatch(mkPayload([{ type: 'video', data: 'x', mimeType: 'video/mp4' }]));

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBe(true);
    expect(asText(result.content[0])).toContain('unknown content block type');
  });

  it('does not interpret legacy {} return as a content-block payload', async () => {
    // Legacy capabilities return arbitrary JSON. {contentBlocks} is the new
    // opt-in shape — anything else must round-trip through JSON.stringify.
    mockDispatch({ result: 42 });

    const result = await callMcpTool('search_knowledge', {}, { userId: 'user-1' });

    expect(result.isError).toBeUndefined();
    expect(asText(result.content[0])).toBe('{"result":42}');
  });
});
