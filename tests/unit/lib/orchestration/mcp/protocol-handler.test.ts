import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/lib/orchestration/mcp/audit-logger', () => ({
  logMcpAudit: vi.fn(),
}));

vi.mock('@/lib/orchestration/mcp/tool-registry', () => ({
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));

vi.mock('@/lib/orchestration/mcp/resource-registry', () => ({
  listMcpResources: vi.fn(),
  readMcpResource: vi.fn(),
  listMcpResourceTemplates: vi.fn(),
}));

vi.mock('@/lib/orchestration/mcp/prompt-registry', () => ({
  listMcpPrompts: vi.fn(),
  getMcpPrompt: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    mcpApiKey: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import { handleMcpRequest, McpProtocolError } from '@/lib/orchestration/mcp/protocol-handler';
import { listMcpTools, callMcpTool } from '@/lib/orchestration/mcp/tool-registry';
import {
  listMcpResources,
  readMcpResource,
  listMcpResourceTemplates,
} from '@/lib/orchestration/mcp/resource-registry';
import { listMcpPrompts, getMcpPrompt } from '@/lib/orchestration/mcp/prompt-registry';
import {
  JsonRpcErrorCode,
  MCP_PROTOCOL_VERSION,
  McpScope,
  type JsonRpcRequest,
  type McpAuthContext,
  type McpSession,
} from '@/types/mcp';
import type { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';
import type { McpServerState } from '@/lib/orchestration/mcp/types';

function makeAuth(overrides: Partial<McpAuthContext> = {}): McpAuthContext {
  return {
    apiKeyId: 'key-1',
    apiKeyName: 'Test Key',
    scopes: Object.values(McpScope),
    createdBy: 'user-1',
    clientIp: '127.0.0.1',
    userAgent: 'test/1.0',
    ...overrides,
  };
}

function makeSession(overrides: Partial<McpSession> = {}): McpSession {
  return {
    id: 'session-1',
    apiKeyId: 'key-1',
    initialized: true,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function makeServerState(overrides: Partial<McpServerState> = {}): McpServerState {
  return {
    isEnabled: true,
    serverName: 'Test MCP Server',
    serverVersion: '1.0.0',
    maxSessionsPerKey: 5,
    globalRateLimit: 60,
    auditRetentionDays: 90,
    ...overrides,
  };
}

function makeRateLimiter(allowed = true): McpRateLimiter {
  return {
    check: vi.fn(() => ({
      success: allowed,
      remaining: allowed ? 59 : 0,
      reset: Date.now() + 60000,
    })),
    clear: vi.fn(),
  } as unknown as McpRateLimiter;
}

function makeRequest(overrides: Partial<JsonRpcRequest> = {}): JsonRpcRequest {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'ping',
    ...overrides,
  };
}

describe('McpProtocolError', () => {
  it('sets the error code and message', () => {
    const err = new McpProtocolError(JsonRpcErrorCode.METHOD_NOT_FOUND, 'Not found');
    expect(err.code).toBe(JsonRpcErrorCode.METHOD_NOT_FOUND);
    expect(err.message).toBe('Not found');
    expect(err.name).toBe('McpProtocolError');
  });

  it('is an instance of Error', () => {
    const err = new McpProtocolError(JsonRpcErrorCode.INTERNAL_ERROR, 'oops');
    expect(err instanceof Error).toBe(true);
  });
});

describe('handleMcpRequest', () => {
  let auth: McpAuthContext;
  let session: McpSession;
  let serverState: McpServerState;
  let rateLimiter: McpRateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    auth = makeAuth();
    session = makeSession();
    serverState = makeServerState();
    rateLimiter = makeRateLimiter(true);
  });

  describe('notifications (no id)', () => {
    it('returns null for notifications/initialized', async () => {
      const req = makeRequest({ id: undefined, method: 'notifications/initialized' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result).toBeNull();
    });

    it('returns null for notifications/cancelled', async () => {
      const req = makeRequest({ id: null, method: 'notifications/cancelled' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result).toBeNull();
    });

    it('returns null for unknown notification methods too', async () => {
      const req = makeRequest({ id: undefined, method: 'notifications/unknown' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result).toBeNull();
    });
  });

  describe('rate limiting', () => {
    it('returns rate_limited error when rate limit is exceeded', async () => {
      const blockedLimiter = makeRateLimiter(false);
      const req = makeRequest({ method: 'ping' });
      const result = await handleMcpRequest(req, {
        auth,
        session,
        serverState,
        rateLimiter: blockedLimiter,
      });
      expect(result?.error).toBeDefined();
      expect(result?.error?.message).toBe('Rate limit exceeded');
    });

    it('includes toolSlug in rate-limited audit entry for tools/call', async () => {
      const blockedLimiter = makeRateLimiter(false);
      const req = makeRequest({
        method: 'tools/call',
        params: { name: 'search_kb', arguments: {} },
      });
      await handleMcpRequest(req, {
        auth,
        session,
        serverState,
        rateLimiter: blockedLimiter,
      });

      const { logMcpAudit } = await import('@/lib/orchestration/mcp/audit-logger');
      expect(logMcpAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          responseCode: 'rate_limited',
          toolSlug: 'search_kb',
        })
      );
    });
  });

  describe('ping', () => {
    it('returns an empty result object', async () => {
      const req = makeRequest({ method: 'ping' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.result).toEqual({});
      expect(result?.error).toBeUndefined();
    });
  });

  describe('initialize', () => {
    it('returns server info and capabilities', async () => {
      const req = makeRequest({ method: 'initialize' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as Record<string, unknown>;
      expect(data.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect((data.serverInfo as Record<string, string>).name).toBe('Test MCP Server');
      expect((data.serverInfo as Record<string, string>).version).toBe('1.0.0');
      expect(data.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
    });
  });

  describe('unknown method', () => {
    it('returns METHOD_NOT_FOUND error', async () => {
      const req = makeRequest({ method: 'foobar/unknown' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.METHOD_NOT_FOUND);
      expect(result?.error?.message).toContain('foobar/unknown');
    });
  });

  describe('uninitialized session', () => {
    it('returns error when tools/list called before initialize', async () => {
      const uninitSession = makeSession({ initialized: false });
      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, {
        auth,
        session: uninitSession,
        serverState,
        rateLimiter,
      });
      expect(result?.error).toBeDefined();
      expect(result?.error?.message).toContain('not initialized');
    });

    it('returns error when tools/call called before initialize', async () => {
      const uninitSession = makeSession({ initialized: false });
      const req = makeRequest({
        method: 'tools/call',
        params: { name: 'search_kb', arguments: {} },
      });
      const result = await handleMcpRequest(req, {
        auth,
        session: uninitSession,
        serverState,
        rateLimiter,
      });
      expect(result?.error).toBeDefined();
    });
  });

  describe('scope enforcement', () => {
    it('returns error when tools:list scope is missing', async () => {
      const noScope = makeAuth({ scopes: [] });
      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, {
        auth: noScope,
        session,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toContain('tools:list');
    });

    it('returns error when tools:execute scope is missing for tools/call', async () => {
      const limitedAuth = makeAuth({ scopes: [McpScope.TOOLS_LIST] });
      const req = makeRequest({
        method: 'tools/call',
        params: { name: 'search_kb', arguments: {} },
      });
      const result = await handleMcpRequest(req, {
        auth: limitedAuth,
        session,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toContain('tools:execute');
    });

    it('returns error when resources:read scope is missing', async () => {
      const limitedAuth = makeAuth({ scopes: [McpScope.TOOLS_LIST] });
      const req = makeRequest({ method: 'resources/list' });
      const result = await handleMcpRequest(req, {
        auth: limitedAuth,
        session,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toContain('resources:read');
    });

    it('returns error when prompts:read scope is missing', async () => {
      const limitedAuth = makeAuth({ scopes: [McpScope.TOOLS_LIST] });
      const req = makeRequest({ method: 'prompts/list' });
      const result = await handleMcpRequest(req, {
        auth: limitedAuth,
        session,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toContain('prompts:read');
    });
  });

  describe('tools/list', () => {
    it('returns the tools list', async () => {
      vi.mocked(listMcpTools).mockResolvedValue([
        { slug: 'search_kb', name: 'search_kb', description: 'Search', inputSchema: {} },
      ]);

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { tools: unknown[] };
      expect(data.tools).toHaveLength(1);
      expect((data.tools[0] as Record<string, unknown>).name).toBe('search_kb');
    });

    it('wraps inputSchema with type: object', async () => {
      vi.mocked(listMcpTools).mockResolvedValue([
        {
          slug: 'my_tool',
          name: 'my_tool',
          description: 'desc',
          inputSchema: { properties: { q: { type: 'string' } } },
        },
      ]);

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const tool = (result?.result as { tools: Record<string, unknown>[] }).tools[0];
      expect((tool.inputSchema as Record<string, unknown>).type).toBe('object');
    });

    it('returns all tools without nextCursor when count is <= 50', async () => {
      const tools = Array.from({ length: 10 }, (_, i) => ({
        slug: `tool_${i}`,
        name: `tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: {},
      }));
      vi.mocked(listMcpTools).mockResolvedValue(tools);

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { tools: unknown[]; nextCursor?: string };
      expect(data.tools).toHaveLength(10);
      expect(data.nextCursor).toBeUndefined();
    });

    it('returns first 50 tools with nextCursor when more than 50 tools exist', async () => {
      const tools = Array.from({ length: 60 }, (_, i) => ({
        slug: `tool_${i}`,
        name: `tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: {},
      }));
      vi.mocked(listMcpTools).mockResolvedValue(tools);

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { tools: unknown[]; nextCursor?: string };
      expect(data.tools).toHaveLength(50);
      expect(data.nextCursor).toBeDefined();
      // cursor encodes offset 50 as base64
      expect(data.nextCursor).toBe(Buffer.from('50').toString('base64'));
    });

    it('returns correct page when a valid cursor is provided', async () => {
      const tools = Array.from({ length: 60 }, (_, i) => ({
        slug: `tool_${i}`,
        name: `tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: {},
      }));
      vi.mocked(listMcpTools).mockResolvedValue(tools);

      const cursor = Buffer.from('50').toString('base64'); // offset 50
      const req = makeRequest({ method: 'tools/list', params: { cursor } });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { tools: unknown[]; nextCursor?: string };
      // items 50-59 returned, no more pages
      expect(data.tools).toHaveLength(10);
      expect(data.nextCursor).toBeUndefined();
    });

    it('starts from the beginning when an invalid cursor is provided', async () => {
      const tools = Array.from({ length: 5 }, (_, i) => ({
        slug: `tool_${i}`,
        name: `tool_${i}`,
        description: `Tool ${i}`,
        inputSchema: {},
      }));
      vi.mocked(listMcpTools).mockResolvedValue(tools);

      const req = makeRequest({ method: 'tools/list', params: { cursor: '!!!invalid!!!' } });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { tools: unknown[]; nextCursor?: string };
      expect(data.tools).toHaveLength(5);
      expect(data.nextCursor).toBeUndefined();
    });
  });

  describe('tools/call', () => {
    it('returns the tool call result', async () => {
      vi.mocked(callMcpTool).mockResolvedValue({
        content: [{ type: 'text', text: 'result text' }],
      });

      const req = makeRequest({
        method: 'tools/call',
        params: { name: 'search_kb', arguments: { q: 'test' } },
      });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error).toBeUndefined();
      expect(callMcpTool).toHaveBeenCalledWith('search_kb', { q: 'test' }, 'user-1');
    });

    it('returns INVALID_PARAMS error when params are missing name', async () => {
      const req = makeRequest({ method: 'tools/call', params: {} });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });

    it('returns INVALID_PARAMS error when params are undefined', async () => {
      const req = makeRequest({ method: 'tools/call', params: undefined });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });
  });

  describe('resources/list', () => {
    it('returns the resources list', async () => {
      vi.mocked(listMcpResources).mockResolvedValue([
        {
          uri: 'sunrise://agents',
          name: 'Agents',
          description: 'Agent list',
          mimeType: 'application/json',
        },
      ]);

      const req = makeRequest({ method: 'resources/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { resources: unknown[] };
      expect(data.resources).toHaveLength(1);
    });

    it('returns all resources without nextCursor when count is <= 50', async () => {
      const resources = Array.from({ length: 5 }, (_, i) => ({
        uri: `sunrise://resource_${i}`,
        name: `Resource ${i}`,
        description: `Desc ${i}`,
        mimeType: 'application/json',
      }));
      vi.mocked(listMcpResources).mockResolvedValue(resources);

      const req = makeRequest({ method: 'resources/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { resources: unknown[]; nextCursor?: string };
      expect(data.resources).toHaveLength(5);
      expect(data.nextCursor).toBeUndefined();
    });

    it('returns first 50 resources with nextCursor when more than 50 exist', async () => {
      const resources = Array.from({ length: 60 }, (_, i) => ({
        uri: `sunrise://resource_${i}`,
        name: `Resource ${i}`,
        description: `Desc ${i}`,
        mimeType: 'application/json',
      }));
      vi.mocked(listMcpResources).mockResolvedValue(resources);

      const req = makeRequest({ method: 'resources/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { resources: unknown[]; nextCursor?: string };
      expect(data.resources).toHaveLength(50);
      expect(data.nextCursor).toBeDefined();
      expect(data.nextCursor).toBe(Buffer.from('50').toString('base64'));
    });

    it('returns correct page when a valid cursor is provided', async () => {
      const resources = Array.from({ length: 60 }, (_, i) => ({
        uri: `sunrise://resource_${i}`,
        name: `Resource ${i}`,
        description: `Desc ${i}`,
        mimeType: 'application/json',
      }));
      vi.mocked(listMcpResources).mockResolvedValue(resources);

      const cursor = Buffer.from('50').toString('base64');
      const req = makeRequest({ method: 'resources/list', params: { cursor } });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { resources: unknown[]; nextCursor?: string };
      expect(data.resources).toHaveLength(10);
      expect(data.nextCursor).toBeUndefined();
    });

    it('starts from the beginning when an invalid cursor is provided', async () => {
      const resources = Array.from({ length: 3 }, (_, i) => ({
        uri: `sunrise://resource_${i}`,
        name: `Resource ${i}`,
        description: `Desc ${i}`,
        mimeType: 'application/json',
      }));
      vi.mocked(listMcpResources).mockResolvedValue(resources);

      const req = makeRequest({
        method: 'resources/list',
        params: { cursor: 'not-valid-base64!!' },
      });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { resources: unknown[]; nextCursor?: string };
      expect(data.resources).toHaveLength(3);
      expect(data.nextCursor).toBeUndefined();
    });
  });

  describe('resources/templates/list', () => {
    it('returns resource templates', async () => {
      vi.mocked(listMcpResourceTemplates).mockResolvedValue([
        {
          uriTemplate: 'sunrise://knowledge/patterns/{number}',
          name: 'Pattern Detail',
          description: 'Get a specific pattern',
          mimeType: 'application/json',
        },
      ]);

      const req = makeRequest({ method: 'resources/templates/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { resourceTemplates: unknown[] };
      expect(data.resourceTemplates).toHaveLength(1);
      expect((data.resourceTemplates[0] as Record<string, unknown>).uriTemplate).toBe(
        'sunrise://knowledge/patterns/{number}'
      );
    });

    it('returns empty array when no templates exist', async () => {
      vi.mocked(listMcpResourceTemplates).mockResolvedValue([]);

      const req = makeRequest({ method: 'resources/templates/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { resourceTemplates: unknown[] };
      expect(data.resourceTemplates).toEqual([]);
    });

    it('requires resources:read scope', async () => {
      const limitedAuth = makeAuth({ scopes: [McpScope.TOOLS_LIST] });
      const req = makeRequest({ method: 'resources/templates/list' });
      const result = await handleMcpRequest(req, {
        auth: limitedAuth,
        session,
        serverState,
        rateLimiter,
      });
      expect(result?.error).toBeDefined();
      expect(result?.error?.message).toContain('resources:read');
    });

    it('returns error when session is not initialized', async () => {
      const uninitSession = makeSession({ initialized: false });
      const req = makeRequest({ method: 'resources/templates/list' });
      const result = await handleMcpRequest(req, {
        auth,
        session: uninitSession,
        serverState,
        rateLimiter,
      });
      expect(result?.error).toBeDefined();
      expect(result?.error?.message).toContain('not initialized');
    });
  });

  describe('resources/read', () => {
    it('returns resource contents when URI is valid', async () => {
      vi.mocked(readMcpResource).mockResolvedValue({
        uri: 'sunrise://agents',
        mimeType: 'application/json',
        text: '[]',
      });

      const req = makeRequest({ method: 'resources/read', params: { uri: 'sunrise://agents' } });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { contents: unknown[] };
      expect(data.contents).toHaveLength(1);
    });

    it('returns INVALID_PARAMS when resource is not found', async () => {
      vi.mocked(readMcpResource).mockResolvedValue(null);

      const req = makeRequest({ method: 'resources/read', params: { uri: 'sunrise://missing' } });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      expect(result?.error?.message).toContain('sunrise://missing');
    });

    it('returns INVALID_PARAMS when uri param is missing', async () => {
      const req = makeRequest({ method: 'resources/read', params: {} });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });
  });

  describe('prompts/list', () => {
    it('returns the prompts list', async () => {
      vi.mocked(listMcpPrompts).mockReturnValue([
        { name: 'analyze-pattern', description: 'Analyze a pattern' },
      ]);

      const req = makeRequest({ method: 'prompts/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { prompts: unknown[] };
      expect(data.prompts).toHaveLength(1);
    });
  });

  describe('prompts/get', () => {
    it('returns prompt messages for a valid prompt', async () => {
      vi.mocked(getMcpPrompt).mockReturnValue([
        { role: 'user', content: { type: 'text', text: 'Analyze pattern #5' } },
      ]);

      const req = makeRequest({
        method: 'prompts/get',
        params: { name: 'analyze-pattern', arguments: { pattern_number: '5' } },
      });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      const data = result?.result as { messages: unknown[] };
      expect(data.messages).toHaveLength(1);
    });

    it('returns INVALID_PARAMS when prompt name is unknown', async () => {
      vi.mocked(getMcpPrompt).mockReturnValue(null);

      const req = makeRequest({
        method: 'prompts/get',
        params: { name: 'nonexistent-prompt' },
      });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      expect(result?.error?.message).toContain('nonexistent-prompt');
    });

    it('returns INVALID_PARAMS when name param is missing', async () => {
      const req = makeRequest({ method: 'prompts/get', params: {} });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });
  });

  describe('JSON-RPC response shape', () => {
    it('success response has jsonrpc 2.0 and matching id', async () => {
      const req = makeRequest({ id: 42, method: 'ping' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.jsonrpc).toBe('2.0');
      expect(result?.id).toBe(42);
      expect(result?.result).toBeDefined();
    });

    it('error response has jsonrpc 2.0 and matching id', async () => {
      const req = makeRequest({ id: 'req-abc', method: 'unknown/method' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.jsonrpc).toBe('2.0');
      expect(result?.id).toBe('req-abc');
      expect(result?.error).toBeDefined();
    });

    it('internal errors are not leaked in error message', async () => {
      vi.mocked(listMcpTools).mockRejectedValue(new Error('DB connection string exposed'));

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.message).toBe('Internal server error');
      expect(result?.error?.message).not.toContain('DB connection string');
    });

    it('McpProtocolError message is forwarded to client', async () => {
      vi.mocked(listMcpTools).mockRejectedValue(
        new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'Bad tool params')
      );

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, { auth, session, serverState, rateLimiter });
      expect(result?.error?.message).toBe('Bad tool params');
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });
  });
});
