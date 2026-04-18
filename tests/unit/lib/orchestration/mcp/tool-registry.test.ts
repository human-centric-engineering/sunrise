import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedTool: {
      findMany: vi.fn(),
    },
    aiAgent: {
      findUnique: vi.fn(),
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCapability(
  overrides: Partial<{
    slug: string;
    isActive: boolean;
    functionDefinition: unknown;
  }> = {}
) {
  return {
    id: 'cap-1',
    slug: 'search_knowledge',
    isActive: true,
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
    expect(logger.warn).toHaveBeenCalled();
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

    const result = await callMcpTool('nonexistent_tool', {}, 'user-1');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown tool');
  });

  it('returns isError=true when mcp-system agent is not found', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([
      makeExposedTool({ customName: 'search_knowledge' }),
    ] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null);

    const result = await callMcpTool('search_knowledge', {}, 'user-1');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('MCP system agent');
    expect(logger.error).toHaveBeenCalled();
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

    const result = await callMcpTool('search_knowledge', { query: 'test' }, 'user-1');

    expect(capabilityDispatcher.dispatch).toHaveBeenCalledWith(
      'search_knowledge',
      { query: 'test' },
      { userId: 'user-1', agentId: 'agent-42' }
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('answer');
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

    const result = await callMcpTool('search_knowledge', {}, 'user-1');

    const parsed = JSON.parse(result.content[0].text);
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

    const result = await callMcpTool('search_knowledge', {}, 'user-1');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Something broke');
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

    const result = await callMcpTool('search_knowledge', {}, 'user-1');

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('Tool execution failed');
  });

  it('passes empty object when args is undefined', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });

    await callMcpTool('search_knowledge', undefined, 'user-1');

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
    await callMcpTool('search_knowledge', {}, 'user-1');
    await callMcpTool('search_knowledge', {}, 'user-1');

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledOnce();
  });

  it('clearMcpToolCache resets the cached agent ID', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-1' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });

    await callMcpTool('search_knowledge', {}, 'user-1');
    clearMcpToolCache();

    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    await callMcpTool('search_knowledge', {}, 'user-1');

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledTimes(2);
  });

  it('resolves agent by slug mcp-system', async () => {
    vi.mocked(prisma.mcpExposedTool.findMany).mockResolvedValue([makeExposedTool()] as never);
    vi.mocked(capabilityFunctionDefinitionSchema.safeParse).mockReturnValue(
      makeSuccessfulParse() as never
    );
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({ id: 'agent-sys' } as never);
    vi.mocked(capabilityDispatcher.dispatch).mockResolvedValue({ success: true, data: {} });

    await callMcpTool('search_knowledge', {}, 'user-1');

    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'mcp-system' } })
    );
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
