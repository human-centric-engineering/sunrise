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

// The fork seam ships empty; tests that need an app resource register one
// explicitly through the public registrar rather than re-mocking this.
vi.mock('@/lib/app/mcp-resources', () => ({
  initAppMcpResources: vi.fn(),
}));

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { handleKnowledgeSearch } from '@/lib/orchestration/mcp/resources/knowledge-search';
import { handlePatternDetail } from '@/lib/orchestration/mcp/resources/pattern-detail';
import { handleAgentList } from '@/lib/orchestration/mcp/resources/agent-list';
import { handleWorkflowList } from '@/lib/orchestration/mcp/resources/workflow-list';
import { initAppMcpResources } from '@/lib/app/mcp-resources';
import {
  listMcpResources,
  readMcpResource,
  clearMcpResourceCache,
  listMcpResourceTemplates,
  isRegisteredMcpResourceUri,
  registerMcpResourceHandler,
  isDispatchableMcpResourceType,
  isAllowedMcpResourceUri,
  isUriSchemeValidForResourceType,
  mcpResourceUriSchemeFor,
  listAppMcpResourceTypes,
  listAllowedMcpResourceUriSchemes,
  __resetAppMcpResourcesForTests,
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

    const result = await readMcpResource('sunrise://knowledge/search', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(handleKnowledgeSearch).toHaveBeenCalledWith('sunrise://knowledge/search', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });
    expect(result).not.toBeNull();
  });

  it('dispatches to agent_list handler', async () => {
    const row = makeResourceRow({ uri: 'sunrise://agents', resourceType: 'agent_list' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleAgentList).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://agents', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(handleAgentList).toHaveBeenCalledWith('sunrise://agents', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });
  });

  it('dispatches to pattern_detail handler', async () => {
    const row = makeResourceRow({
      uri: 'sunrise://knowledge/patterns/1',
      resourceType: 'pattern_detail',
    });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handlePatternDetail).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://knowledge/patterns/1', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(handlePatternDetail).toHaveBeenCalledWith('sunrise://knowledge/patterns/1', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });
  });

  it('dispatches to workflow_list handler', async () => {
    const row = makeResourceRow({ uri: 'sunrise://workflows', resourceType: 'workflow_list' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleWorkflowList).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://workflows', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(handleWorkflowList).toHaveBeenCalledWith('sunrise://workflows', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });
  });

  it('passes handlerConfig as record to the handler', async () => {
    const handlerConfig = { maxResults: 5 };
    const row = makeResourceRow({ resourceType: 'knowledge_search', handlerConfig });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleKnowledgeSearch).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://knowledge/search', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(handleKnowledgeSearch).toHaveBeenCalledWith(
      'sunrise://knowledge/search',
      { maxResults: 5 },
      { scopedAgentId: null, apiKeyId: 'key-1', userId: null }
    );
  });

  it('returns null and warns when no handler exists for resourceType', async () => {
    const row = makeResourceRow({ resourceType: 'unknown_type' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);

    const result = await readMcpResource('sunrise://knowledge/search', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null when exact match is disabled', async () => {
    const row = makeResourceRow({ isEnabled: false });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    // Pattern fallback also finds nothing
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    const result = await readMcpResource('sunrise://knowledge/search', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toBeNull();
  });

  it('returns null when row is not found by exact URI', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);

    const result = await readMcpResource('sunrise://unknown/resource', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

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

    const result = await readMcpResource('sunrise://knowledge/patterns/5', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(handlePatternDetail).toHaveBeenCalledWith('sunrise://knowledge/patterns/5', null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });
    expect(result).not.toBeNull();
  });

  it('matches a template whose {param} is NOT the last path segment', async () => {
    // `sunrise://projects/{id}/plan` collapses to `sunrise://projects//plan`
    // under the strip-then-startsWith test, which no concrete URI starts with —
    // so this returned null before the template matcher was added. Every core
    // template happens to be trailing, which is why nothing noticed.
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://projects/{id}/plan', resourceType: 'pattern_detail' }),
    ] as never);
    vi.mocked(handlePatternDetail).mockResolvedValue(
      makeResourceContent('sunrise://projects/p1/plan')
    );

    const result = await readMcpResource('sunrise://projects/p1/plan', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toEqual(makeResourceContent('sunrise://projects/p1/plan'));
  });

  it('does not let a mid-path {param} swallow extra path segments', async () => {
    // `{id}` is one segment, not "the rest of the path" — otherwise the new
    // matcher would be looser than the prefix test it sits beside.
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://projects/{id}/plan', resourceType: 'pattern_detail' }),
    ] as never);

    const result = await readMcpResource('sunrise://projects/p1/nested/plan', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toBeNull();
    expect(handlePatternDetail).not.toHaveBeenCalled();
  });

  it('treats adjacent {params} as one segment rather than two quantifiers', async () => {
    // `{a}{b}` compiling to `[^/]+[^/]+` backtracks polynomially against a long
    // non-matching URI, and the URI side is client-supplied. Collapsing the run
    // also gives the sane semantics: one value fills the pair.
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://x/{a}{b}/plan', resourceType: 'pattern_detail' }),
    ] as never);
    vi.mocked(handlePatternDetail).mockResolvedValue(makeResourceContent('sunrise://x/one/plan'));

    expect(
      await readMcpResource('sunrise://x/one/plan', {
        scopedAgentId: null,
        apiKeyId: 'k',
        userId: null,
      })
    ).toEqual(makeResourceContent('sunrise://x/one/plan'));

    // The pathological input returns promptly rather than backtracking.
    // Measured: five adjacent placeholders against 120 non-matching characters
    // takes ~13s uncollapsed and ~0.01ms collapsed, so the bound below has five
    // orders of magnitude of headroom and cannot flake on a slow runner.
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://x/{a}{b}{c}{d}{e}end', resourceType: 'pattern_detail' }),
    ] as never);
    const started = performance.now();
    await readMcpResource(`sunrise://x/${'a'.repeat(120)}`, {
      scopedAgentId: null,
      apiKeyId: 'k',
      userId: null,
    });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('returns null from pattern matching when no patterns match', async () => {
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://agents', resourceType: 'agent_list' }),
    ] as never);

    const result = await readMcpResource('sunrise://completely/different/path', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toBeNull();
  });

  it('returns error content when exact-match handler throws', async () => {
    const row = makeResourceRow({ resourceType: 'knowledge_search' });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleKnowledgeSearch).mockRejectedValue(new Error('handler boom'));

    const result = await readMcpResource('sunrise://knowledge/search', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

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

    const result = await readMcpResource('sunrise://knowledge/patterns/5', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

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

    await readMcpResource('sunrise://knowledge/search', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

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

    const result = await readMcpResource('sunrise://knowledge/search', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toBeNull();
  });

  it('treats non-object handlerConfig as null', async () => {
    const row = makeResourceRow({ resourceType: 'agent_list', handlerConfig: ['array', 'value'] });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(row as never);
    vi.mocked(handleAgentList).mockResolvedValue(makeResourceContent(row.uri));

    await readMcpResource('sunrise://agents', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(handleAgentList).toHaveBeenCalledWith(expect.any(String), null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });
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

// ---------------------------------------------------------------------------
// isRegisteredMcpResourceUri
// ---------------------------------------------------------------------------

describe('isRegisteredMcpResourceUri', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpResourceCache();
  });

  it('returns true for an exact match on a registered URI', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://agents' }),
    ] as never);

    expect(await isRegisteredMcpResourceUri('sunrise://agents')).toBe(true);
  });

  it('returns true for a concrete instance of a parameterised template', async () => {
    // Template `sunrise://knowledge/patterns/{number}` should match
    // `sunrise://knowledge/patterns/5`.
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({
        uri: 'sunrise://knowledge/patterns/{number}',
        resourceType: 'pattern_detail',
      }),
    ] as never);

    expect(await isRegisteredMcpResourceUri('sunrise://knowledge/patterns/5')).toBe(true);
  });

  it('returns true for a concrete instance with multiple path segments after the prefix', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://knowledge/search?q={query}' }),
    ] as never);

    expect(await isRegisteredMcpResourceUri('sunrise://knowledge/search?q=patterns')).toBe(true);
  });

  it('returns false for a URI no registered resource covers', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://agents' }),
    ] as never);

    expect(await isRegisteredMcpResourceUri('sunrise://unknown')).toBe(false);
  });

  it('returns false when no resources are registered', async () => {
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([]);
    expect(await isRegisteredMcpResourceUri('sunrise://anything')).toBe(false);
  });

  it('does not match a different template prefix', async () => {
    // `sunrise://workflows/{id}` must not match `sunrise://agents/foo`.
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'sunrise://workflows/{id}' }),
    ] as never);

    expect(await isRegisteredMcpResourceUri('sunrise://agents/foo')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// App-owned resource handlers — the #563 / #540 fork seam
// ---------------------------------------------------------------------------

describe('app-registered resource handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearMcpResourceCache();
    __resetAppMcpResourcesForTests();
  });

  it('ships with no app types and only the core URI scheme', () => {
    expect(listAppMcpResourceTypes()).toEqual([]);
    expect(listAllowedMcpResourceUriSchemes()).toEqual(['sunrise']);
  });

  it('dispatches a read to an app handler for an app resourceType', async () => {
    const handler = vi.fn().mockResolvedValue(makeResourceContent('hub://projects/p1/plan'));
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({ resourceType: 'project_plan', uriScheme: 'hub', handler });
    });
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(
      makeResourceRow({
        uri: 'hub://projects/p1/plan',
        resourceType: 'project_plan',
        handlerConfig: { depth: 2 },
      }) as never
    );

    const result = await readMcpResource('hub://projects/p1/plan', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toEqual(makeResourceContent('hub://projects/p1/plan'));
    // Same three-argument contract the built-ins get, config included.
    expect(handler).toHaveBeenCalledWith(
      'hub://projects/p1/plan',
      { depth: 2 },
      { scopedAgentId: null, apiKeyId: 'key-1', userId: null }
    );
  });

  it('runs the fork init exactly once across many reads', async () => {
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'hub',
        handler: vi.fn().mockResolvedValue(makeResourceContent('hub://x')),
      });
    });

    isDispatchableMcpResourceType('project_plan');
    isDispatchableMcpResourceType('project_plan');
    isAllowedMcpResourceUri('hub://x');
    listAppMcpResourceTypes();

    expect(initAppMcpResources).toHaveBeenCalledTimes(1);
  });

  it('degrades to no app resources when the fork init throws', async () => {
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      throw new Error('fork boom');
    });

    // The throw must not propagate out of an MCP read...
    expect(isDispatchableMcpResourceType('project_plan')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('initAppMcpResources threw'),
      expect.objectContaining({ error: 'fork boom' })
    );

    // ...and the latch means it is not retried on every subsequent read.
    isDispatchableMcpResourceType('project_plan');
    expect(initAppMcpResources).toHaveBeenCalledTimes(1);
  });

  it('rolls back a PARTIAL init, so no half-configured resource is exposed', () => {
    // This registry has the most to lose from a partial apply: a registered
    // handler dispatches, and its scheme is accepted at create — so a fork could
    // expose a resource it never finished configuring while the log claims none
    // were registered.
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'hub',
        handler: vi.fn(),
      });
      throw new Error('fork boom on the second');
    });

    expect(listAppMcpResourceTypes()).toEqual([]);
    expect(isDispatchableMcpResourceType('project_plan')).toBe(false);
    expect(listAllowedMcpResourceUriSchemes()).toEqual(['sunrise']);
    expect(isAllowedMcpResourceUri('hub://projects/1')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('rolled back and disabled'),
      expect.objectContaining({ error: 'fork boom on the second' })
    );
  });

  it('refuses to let an app registration shadow a built-in type', async () => {
    const impostor = vi.fn().mockResolvedValue(makeResourceContent('sunrise://agents'));
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'agent_list',
        uriScheme: 'sunrise',
        handler: impostor,
      });
    });
    vi.mocked(handleAgentList).mockResolvedValue(makeResourceContent('sunrise://agents'));
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(
      makeResourceRow({ uri: 'sunrise://agents', resourceType: 'agent_list' }) as never
    );

    await readMcpResource('sunrise://agents', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    // The seeded core resource still answers with core's handler — otherwise a
    // fork could silently change what an external MCP client is served.
    expect(handleAgentList).toHaveBeenCalledTimes(1);
    expect(impostor).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('refusing to override a built-in resource type'),
      { resourceType: 'agent_list' }
    );
  });

  it.each([
    ['https', 'a scheme an MCP client could mistake for a fetchable address'],
    ['javascript', 'a scheme that is dangerous anywhere it is dereferenced'],
    ['', 'an empty scheme'],
    ['has space', 'a scheme that is not a valid URI scheme'],
  ])('refuses the URI scheme %j — %s', (uriScheme) => {
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme,
        handler: vi.fn(),
      });
    });

    expect(listAppMcpResourceTypes()).toEqual([]);
    expect(listAllowedMcpResourceUriSchemes()).toEqual(['sunrise']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('refusing to register an unusable URI scheme'),
      expect.objectContaining({ resourceType: 'project_plan' })
    );
  });

  it('lowercases a registered scheme but will not accept an uppercase URI', () => {
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'Hub',
        handler: vi.fn(),
      });
    });

    // Forgiving about the fork's config…
    expect(listAllowedMcpResourceUriSchemes()).toEqual(['sunrise', 'hub']);
    expect(isAllowedMcpResourceUri('hub://projects/1')).toBe(true);

    // …exact about a stored URI. `readMcpResource` looks a row up by EXACT
    // uri, so accepting `HUB://` at creation would mint a row that can never
    // dispatch — the failure this check exists to prevent (#540).
    expect(isAllowedMcpResourceUri('HUB://projects/1')).toBe(false);
    expect(isAllowedMcpResourceUri('SUNRISE://agents')).toBe(false);
  });

  it('does not treat an unregistered scheme as allowed', () => {
    expect(isAllowedMcpResourceUri('obsiddy://today')).toBe(false);
    expect(isAllowedMcpResourceUri('sunrise://agents')).toBe(true);
    expect(isAllowedMcpResourceUri('not-a-uri')).toBe(false);
  });

  it('binds a resourceType to the scheme it was registered under', () => {
    // Checking "is this scheme allowed?" and "does this type dispatch?"
    // independently is not enough. With `project_plan` registered under `hub`,
    // both pass for `sunrise://projects/x/plan` — and the row then serves fork
    // data under the PLATFORM's scheme to every MCP client that lists it, which
    // is the inheritance `uriScheme` is required in order to prevent.
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'hub',
        handler: vi.fn(),
      });
    });

    // Both independent checks pass for the mismatched pair…
    expect(isAllowedMcpResourceUri('sunrise://projects/x/plan')).toBe(true);
    expect(isDispatchableMcpResourceType('project_plan')).toBe(true);
    // …and the pair check is what rejects it.
    expect(isUriSchemeValidForResourceType('sunrise://projects/x/plan', 'project_plan')).toBe(
      false
    );
    expect(isUriSchemeValidForResourceType('hub://projects/x/plan', 'project_plan')).toBe(true);
  });

  it('pins a built-in resourceType to the core scheme', () => {
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({
        resourceType: 'project_plan',
        uriScheme: 'hub',
        handler: vi.fn(),
      });
    });

    expect(mcpResourceUriSchemeFor('agent_list')).toBe('sunrise');
    expect(mcpResourceUriSchemeFor('project_plan')).toBe('hub');
    expect(mcpResourceUriSchemeFor('nope')).toBeUndefined();
    // The inverse of the case above: a core type may not move to a fork scheme.
    expect(isUriSchemeValidForResourceType('hub://agents', 'agent_list')).toBe(false);
  });

  it.each([
    ['projectPlan', 'camelCase'],
    ['Project_Plan', 'upper case'],
    ['project-plan', 'a hyphen'],
    ['9plan', 'a leading digit'],
    ['', 'empty'],
    ['a'.repeat(65), 'over the 64-char cap'],
  ])('refuses the malformed resourceType %j (%s)', (resourceType) => {
    // Without this, registering `projectPlan` succeeds and reports
    // dispatchable, and then every attempt to create the row 400s at Zod with a
    // message that never mentions the registration.
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({ resourceType, uriScheme: 'hub', handler: vi.fn() });
    });

    expect(listAppMcpResourceTypes()).toEqual([]);
    expect(isDispatchableMcpResourceType(resourceType)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('malformed resourceType'),
      expect.objectContaining({ resourceType })
    );
  });

  it('does not resolve an inherited Object property as a handler', () => {
    // `resourceType` comes off a DB row; a bare object lookup would answer
    // `constructor` with something that is not a handler.
    expect(isDispatchableMcpResourceType('constructor')).toBe(false);
    expect(isDispatchableMcpResourceType('__proto__')).toBe(false);
  });

  it('dispatches an app handler through the parameterised-URI path too', async () => {
    const handler = vi.fn().mockResolvedValue(makeResourceContent('hub://projects/p1/plan'));
    vi.mocked(initAppMcpResources).mockImplementation(() => {
      registerMcpResourceHandler({ resourceType: 'project_plan', uriScheme: 'hub', handler });
    });
    // No exact row → falls through to readMcpResourceByPattern.
    vi.mocked(prisma.mcpExposedResource.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.mcpExposedResource.findMany).mockResolvedValue([
      makeResourceRow({ uri: 'hub://projects/{id}/plan', resourceType: 'project_plan' }),
    ] as never);

    const result = await readMcpResource('hub://projects/p1/plan', {
      scopedAgentId: null,
      apiKeyId: 'key-1',
      userId: null,
    });

    expect(result).toEqual(makeResourceContent('hub://projects/p1/plan'));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
