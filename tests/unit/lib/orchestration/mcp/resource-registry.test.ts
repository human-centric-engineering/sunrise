import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpExposedResource: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/lib/orchestration/mcp/resources/knowledge-search', () => ({
  handleKnowledgeSearch: vi.fn(),
}));

vi.mock('@/lib/orchestration/mcp/resources/pattern-detail', () => ({
  handlePatternDetail: vi.fn(),
}));

vi.mock('@/lib/orchestration/mcp/resources/agent-list', () => ({
  handleAgentList: vi.fn(),
}));

vi.mock('@/lib/orchestration/mcp/resources/workflow-list', () => ({
  handleWorkflowList: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { handleKnowledgeSearch } from '@/lib/orchestration/mcp/resources/knowledge-search';
import { handlePatternDetail } from '@/lib/orchestration/mcp/resources/pattern-detail';
import { handleAgentList } from '@/lib/orchestration/mcp/resources/agent-list';
import { handleWorkflowList } from '@/lib/orchestration/mcp/resources/workflow-list';
import {
  listMcpResources,
  readMcpResource,
  clearMcpResourceCache,
  listMcpResourceTemplates,
} from '@/lib/orchestration/mcp/resource-registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResourceRow(
  overrides: Partial<{
    id: string;
    uri: string;
    name: string;
    description: string;
    mimeType: string;
    resourceType: string;
    isEnabled: boolean;
    handlerConfig: unknown;
  }> = {}
) {
  return {
    id: 'res-1',
    uri: 'sunrise://knowledge/search',
    name: 'Knowledge Search',
    description: 'Search knowledge base',
    mimeType: 'application/json',
    resourceType: 'knowledge_search',
    isEnabled: true,
    handlerConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeResourceContent(uri: string) {
  return {
    uri,
    mimeType: 'application/json',
    text: JSON.stringify({ results: [] }),
  };
}

// ---------------------------------------------------------------------------
// listMcpResources
// ---------------------------------------------------------------------------

describe('listMcpResources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpResourceCache();
  });

  it('queries mcpExposedResource with isEnabled=true filter', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    await listMcpResources();

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledWith({
      where: { isEnabled: true },
    });
  });

  it('returns empty array when no resources are found', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    const result = await listMcpResources();
    expect(result).toEqual([]);
  });

  it('maps rows to McpResourceDefinition shape', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([makeResourceRow()] as never);

    const result = await listMcpResources();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      uri: 'sunrise://knowledge/search',
      name: 'Knowledge Search',
      description: 'Search knowledge base',
      mimeType: 'application/json',
    });
  });

  it('caches results on second call within TTL', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    await listMcpResources();
    await listMcpResources();

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledOnce();
  });

  it('re-fetches after clearMcpResourceCache', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    await listMcpResources();
    clearMcpResourceCache();
    await listMcpResources();

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledTimes(2);
  });

  it('maps multiple rows correctly', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://knowledge/search', name: 'Search' }),
      makeResourceRow({
        id: 'res-2',
        uri: 'sunrise://agents',
        name: 'Agents',
        resourceType: 'agent_list',
      }),
    ] as never);

    const result = await listMcpResources();
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.uri)).toEqual(['sunrise://knowledge/search', 'sunrise://agents']);
  });
});

// ---------------------------------------------------------------------------
// readMcpResource
// ---------------------------------------------------------------------------

describe('readMcpResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpResourceCache();
  });

  it('dispatches to knowledge_search handler for exact URI match', async () => {
    const row = makeResourceRow({ resourceType: 'knowledge_search' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleKnowledgeSearch).mockResolvedValue(makeResourceContent(row.uri));

    const result = await readMcpResource('sunrise://knowledge/search');

    expect(handleKnowledgeSearch).toHaveBeenCalledWith('sunrise://knowledge/search', null);
    expect(result).not.toBeNull();
  });

  it('dispatches to agent_list handler', async () => {
    const row = makeResourceRow({ uri: 'sunrise://agents', resourceType: 'agent_list' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleAgentList).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://agents');

    expect(handleAgentList).toHaveBeenCalledWith('sunrise://agents', null);
  });

  it('dispatches to pattern_detail handler', async () => {
    const row = makeResourceRow({
      uri: 'sunrise://knowledge/patterns/1',
      resourceType: 'pattern_detail',
    });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handlePatternDetail).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://knowledge/patterns/1');

    expect(handlePatternDetail).toHaveBeenCalledWith('sunrise://knowledge/patterns/1', null);
  });

  it('dispatches to workflow_list handler', async () => {
    const row = makeResourceRow({ uri: 'sunrise://workflows', resourceType: 'workflow_list' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleWorkflowList).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://workflows');

    expect(handleWorkflowList).toHaveBeenCalledWith('sunrise://workflows', null);
  });

  it('passes handlerConfig as record to the handler', async () => {
    const handlerConfig = { maxResults: 5 };
    const row = makeResourceRow({ resourceType: 'knowledge_search', handlerConfig });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleKnowledgeSearch).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://knowledge/search');

    expect(handleKnowledgeSearch).toHaveBeenCalledWith('sunrise://knowledge/search', {
      maxResults: 5,
    });
  });

  it('returns null and warns when no handler exists for resourceType', async () => {
    const row = makeResourceRow({ resourceType: 'unknown_type' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);

    const result = await readMcpResource('sunrise://knowledge/search');

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null when exact match is disabled', async () => {
    const row = makeResourceRow({ isEnabled: false });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    // Pattern fallback also finds nothing
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    const result = await readMcpResource('sunrise://knowledge/search');

    expect(result).toBeNull();
  });

  it('returns null when row is not found by exact URI', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    const result = await readMcpResource('sunrise://unknown/resource');

    expect(result).toBeNull();
  });

  it('falls back to pattern matching when exact match returns null', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    const patternRow = makeResourceRow({
      uri: 'sunrise://knowledge/patterns/{number}',
      resourceType: 'pattern_detail',
    });
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([patternRow] as never);
    vi.mocked(handlePatternDetail).mockResolvedValue(
      makeResourceContent('sunrise://knowledge/patterns/5')
    );

    const result = await readMcpResource('sunrise://knowledge/patterns/5');

    expect(handlePatternDetail).toHaveBeenCalledWith('sunrise://knowledge/patterns/5', null);
    expect(result).not.toBeNull();
  });

  it('returns null from pattern matching when no patterns match', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://agents', resourceType: 'agent_list' }),
    ] as never);

    const result = await readMcpResource('sunrise://completely/different/path');

    expect(result).toBeNull();
  });

  it('returns error content when exact-match handler throws', async () => {
    const row = makeResourceRow({ resourceType: 'knowledge_search' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleKnowledgeSearch).mockRejectedValue(new Error('handler boom'));

    const result = await readMcpResource('sunrise://knowledge/search');

    expect(result).toEqual({
      uri: 'sunrise://knowledge/search',
      mimeType: 'application/json',
      text: 'Resource handler error',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'MCP resource handler failed',
      expect.objectContaining({ error: 'handler boom' })
    );
  });

  it('returns error content when pattern-match handler throws', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    const patternRow = makeResourceRow({
      uri: 'sunrise://knowledge/patterns/{number}',
      resourceType: 'pattern_detail',
    });
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([patternRow] as never);
    vi.mocked(handlePatternDetail).mockRejectedValue(new Error('pattern boom'));

    const result = await readMcpResource('sunrise://knowledge/patterns/5');

    expect(result).toEqual({
      uri: 'sunrise://knowledge/patterns/5',
      mimeType: 'application/json',
      text: 'Resource handler error',
    });
    expect(logger.error).toHaveBeenCalledWith(
      'MCP resource handler failed (pattern match)',
      expect.objectContaining({ error: 'pattern boom' })
    );
  });

  it('logs non-Error throws with String() in exact-match handler', async () => {
    const row = makeResourceRow({ resourceType: 'knowledge_search' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleKnowledgeSearch).mockRejectedValue('string error');

    await readMcpResource('sunrise://knowledge/search');

    expect(logger.error).toHaveBeenCalledWith(
      'MCP resource handler failed',
      expect.objectContaining({ error: 'string error' })
    );
  });

  it('skips pattern row when no handler exists for its resourceType', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    const noHandlerRow = makeResourceRow({
      uri: 'sunrise://knowledge/',
      resourceType: 'nonexistent_type',
    });
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([noHandlerRow] as never);

    const result = await readMcpResource('sunrise://knowledge/search');

    expect(result).toBeNull();
  });

  it('treats non-object handlerConfig as null', async () => {
    const row = makeResourceRow({ resourceType: 'agent_list', handlerConfig: ['array', 'value'] });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleAgentList).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://agents');

    expect(handleAgentList).toHaveBeenCalledWith(expect.any(String), null);
  });
});

// ---------------------------------------------------------------------------
// clearMcpResourceCache
// ---------------------------------------------------------------------------

describe('clearMcpResourceCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpResourceCache();
  });

  it('forces a fresh DB read on the next listMcpResources call', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    await listMcpResources();
    clearMcpResourceCache();
    await listMcpResources();

    expect(prisma.mcpExposedResource.findMany).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// listMcpResourceTemplates
// ---------------------------------------------------------------------------

describe('listMcpResourceTemplates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no enabled resources have URI placeholders or query strings', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://agents' }),
      makeResourceRow({ id: 'res-2', uri: 'sunrise://workflows', name: 'Workflows' }),
    ] as never);

    const result = await listMcpResourceTemplates();

    expect(result).toEqual([]);
  });

  it('returns templates for resources whose URI contains {param} placeholders', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({
        uri: 'sunrise://knowledge/patterns/{number}',
        name: 'Pattern Detail',
        description: 'Get a specific pattern',
        mimeType: 'application/json',
      }),
    ] as never);

    const result = await listMcpResourceTemplates();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      uriTemplate: 'sunrise://knowledge/patterns/{number}',
      name: 'Pattern Detail',
      description: 'Get a specific pattern',
      mimeType: 'application/json',
    });
  });

  it('returns templates for resources whose URI contains ? query params', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({
        uri: 'sunrise://knowledge/search?q=foo',
        name: 'Knowledge Search',
        description: 'Search with query',
        mimeType: 'application/json',
      }),
    ] as never);

    const result = await listMcpResourceTemplates();

    expect(result).toHaveLength(1);
    expect(result[0].uriTemplate).toBe('sunrise://knowledge/search?q=foo');
  });

  it('does not return resources without placeholders or query strings', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://agents', name: 'Agents' }),
      makeResourceRow({
        id: 'res-2',
        uri: 'sunrise://knowledge/patterns/{id}',
        name: 'Pattern',
      }),
    ] as never);

    const result = await listMcpResourceTemplates();

    expect(result).toHaveLength(1);
    expect(result[0].uriTemplate).toBe('sunrise://knowledge/patterns/{id}');
  });

  it('maps rows correctly to McpResourceTemplate shape', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({
        uri: 'sunrise://agents/{agentId}',
        name: 'Agent Detail',
        description: 'Get agent by ID',
        mimeType: 'application/json',
      }),
    ] as never);

    const result = await listMcpResourceTemplates();

    expect(result[0]).toEqual({
      uriTemplate: 'sunrise://agents/{agentId}',
      name: 'Agent Detail',
      description: 'Get agent by ID',
      mimeType: 'application/json',
    });
  });

  it('returns multiple templates when multiple resources match', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://agents', name: 'Agents' }),
      makeResourceRow({
        id: 'res-2',
        uri: 'sunrise://agents/{agentId}',
        name: 'Agent Detail',
      }),
      makeResourceRow({
        id: 'res-3',
        uri: 'sunrise://knowledge/patterns/{number}',
        name: 'Pattern Detail',
        resourceType: 'pattern_detail',
      }),
    ] as never);

    const result = await listMcpResourceTemplates();

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.uriTemplate)).toEqual([
      'sunrise://agents/{agentId}',
      'sunrise://knowledge/patterns/{number}',
    ]);
  });
});
