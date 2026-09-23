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

vi.mock('@/lib/orchestration/mcp/completion-registry', () => ({
  completeMcpReference: vi.fn(),
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

import {
  handleMcpRequest,
  McpProtocolError,
  __resetKeyRateLimitCacheForTests,
} from '@/lib/orchestration/mcp/protocol-handler';
import { listMcpTools, callMcpTool } from '@/lib/orchestration/mcp/tool-registry';
import {
  listMcpResources,
  readMcpResource,
  listMcpResourceTemplates,
} from '@/lib/orchestration/mcp/resource-registry';
import { listMcpPrompts, getMcpPrompt } from '@/lib/orchestration/mcp/prompt-registry';
import { completeMcpReference } from '@/lib/orchestration/mcp/completion-registry';
import {
  JsonRpcErrorCode,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_MIN_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION,
  McpScope,
  type JsonRpcRequest,
  type McpAuthContext,
  type McpProtocolVersion,
} from '@/types/mcp';
import type { McpRateLimiter } from '@/lib/orchestration/mcp/rate-limiter';
import type { McpServerState } from '@/lib/orchestration/mcp/types';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { getTenantContext, runAsOrg, type TenantContext } from '@/lib/tenancy/context';

function makeAuth(overrides: Partial<McpAuthContext> = {}): McpAuthContext {
  return {
    apiKeyId: 'key-1',
    apiKeyName: 'Test Key',
    scopes: Object.values(McpScope),
    createdBy: 'user-1',
    clientIp: '127.0.0.1',
    userAgent: 'test/1.0',
    scopedAgentId: null,
    orgId: 'install',
    ...overrides,
  };
}

function makeServerState(overrides: Partial<McpServerState> = {}): McpServerState {
  return {
    isEnabled: true,
    serverName: 'Test MCP Server',
    serverVersion: '1.0.0',
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
    // test-review:accept tobe_true — boolean instanceof check; verifying McpProtocolError extends Error
    expect(err instanceof Error).toBe(true);
  });
});

describe('handleMcpRequest', () => {
  let auth: McpAuthContext;
  /**
   * The revision the caller declared, which the transport resolves from the
   * `MCP-Protocol-Version` header. It replaced a whole session fixture (§39
   * t-718) — the handler reads nothing else off a per-connection object now,
   * because there is no connection.
   */
  let protocolVersion: McpProtocolVersion;
  let serverState: McpServerState;
  let rateLimiter: McpRateLimiter;

  beforeEach(() => {
    vi.clearAllMocks();
    auth = makeAuth();
    protocolVersion = MCP_LATEST_PROTOCOL_VERSION;
    serverState = makeServerState();
    rateLimiter = makeRateLimiter(true);
  });

  describe('notifications (no id)', () => {
    it('returns null for notifications/initialized', async () => {
      const req = makeRequest({ id: undefined, method: 'notifications/initialized' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result).toBeNull();
    });

    it('returns null for notifications/cancelled', async () => {
      const req = makeRequest({ id: null, method: 'notifications/cancelled' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result).toBeNull();
    });

    it('returns null for unknown notification methods too', async () => {
      const req = makeRequest({ id: undefined, method: 'notifications/unknown' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result).toBeNull();
    });
  });

  describe('the per-key rate-limit override cache (§108 t-712)', () => {
    it("reads every org's keys under the audited system scope, not the caller's org", async () => {
      __resetKeyRateLimitCacheForTests();
      const scopes: (TenantContext | null)[] = [];
      vi.mocked(prisma.mcpApiKey.findMany).mockImplementation(() => {
        scopes.push(getTenantContext());
        return Promise.resolve([]) as never;
      });

      // The cache is keyed by API key id, which is unique across orgs, so one
      // process-wide map is right — but it used to be FILLED inside whichever
      // org's request happened to trigger the refresh, and `McpApiKey` is
      // tenant-owned. Every other org's key then fell back to the global limit
      // until the next refresh.
      await runAsOrg('cmorg00000000000000000orga', async () => {
        await handleMcpRequest(makeRequest({ method: 'ping' }), {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
      });

      await vi.waitFor(() => expect(scopes).toHaveLength(1));
      expect(scopes[0]).toEqual({ orgId: null, source: 'system' });
    });

    it('starts one refresh for a burst, not one per request', async () => {
      __resetKeyRateLimitCacheForTests();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(prisma.mcpApiKey.findMany).mockImplementation(
        () => blocked.then(() => []) as never
      );

      // The stamp is only written when the refresh resolves, so without the
      // in-flight latch each of these starts its own audited bypass.
      for (let i = 0; i < 5; i++) {
        await handleMcpRequest(makeRequest({ method: 'ping' }), {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
      }

      // The refresh reaches the database through two dynamic imports, so wait
      // for the first call, then let every other pending chain settle before
      // counting. Asserting "1" the moment one arrives would pass without the
      // latch too, because the other four are still in flight.
      await vi.waitFor(() => expect(prisma.mcpApiKey.findMany).toHaveBeenCalled());
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));

      expect(prisma.mcpApiKey.findMany).toHaveBeenCalledTimes(1);
      release();
    });

    it('logs a failed refresh instead of leaving an unhandled rejection', async () => {
      __resetKeyRateLimitCacheForTests();
      vi.mocked(prisma.mcpApiKey.findMany).mockRejectedValue(new Error('pool exhausted'));

      await handleMcpRequest(makeRequest({ method: 'ping' }), {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });

      await vi.waitFor(() =>
        expect(logger.warn).toHaveBeenCalledWith(
          'MCP per-key rate-limit overrides could not be refreshed',
          expect.objectContaining({ error: 'pool exhausted' })
        )
      );
    });

    it('backs off after a failure instead of retrying on every request', async () => {
      __resetKeyRateLimitCacheForTests();
      vi.mocked(prisma.mcpApiKey.findMany).mockRejectedValue(new Error('pool exhausted'));

      // The freshness stamp is only written on success, so without a backoff
      // every one of these starts its own audited bypass and logs a warn.
      for (let i = 0; i < 4; i++) {
        await handleMcpRequest(makeRequest({ method: 'ping' }), {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      expect(prisma.mcpApiKey.findMany).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('rate limiting', () => {
    it('returns RATE_LIMITED (-32004) error when rate limit is exceeded', async () => {
      const blockedLimiter = makeRateLimiter(false);
      const req = makeRequest({ method: 'ping' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter: blockedLimiter,
      });
      expect(result?.error).toBeDefined();
      expect(result?.error?.code).toBe(JsonRpcErrorCode.RATE_LIMITED);
      expect(result?.error?.code).toBe(-32004);
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
        protocolVersion,
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.result).toEqual({});
      expect(result?.error).toBeUndefined();
    });
  });

  describe('initialize', () => {
    it('returns server info and capabilities', async () => {
      const req = makeRequest({
        method: 'initialize',
        params: { protocolVersion: MCP_LATEST_PROTOCOL_VERSION },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as Record<string, unknown>;
      expect(data.protocolVersion).toBe(MCP_LATEST_PROTOCOL_VERSION);
      expect((data.serverInfo as Record<string, string>).name).toBe('Test MCP Server');
      expect((data.serverInfo as Record<string, string>).version).toBe('1.0.0');
      // Only advertise features the server actually implements. Every
      // capability that would PUSH — `listChanged`, `resources.subscribe`,
      // `logging: {}` — went with the stateful transport (§39 t-718).
      // `completions: {}` signals `completion/complete`, which is a plain
      // request/response lookup.
      expect(data.capabilities).toEqual({
        tools: {},
        resources: {},
        prompts: {},
        completions: {},
      });
    });

    describe('version negotiation', () => {
      it('honours an explicitly-requested supported version', async () => {
        const req = makeRequest({
          method: 'initialize',
          params: { protocolVersion: '2024-11-05' },
        });
        const result = await handleMcpRequest(req, {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
        expect((result?.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
      });

      it('defaults to the oldest supported version when client omits protocolVersion', async () => {
        const req = makeRequest({ method: 'initialize' });
        const result = await handleMcpRequest(req, {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
        expect((result?.result as { protocolVersion: string }).protocolVersion).toBe(
          MCP_MIN_PROTOCOL_VERSION
        );
      });

      it('downgrades a forward-dated unknown version to the latest supported', async () => {
        const req = makeRequest({
          method: 'initialize',
          params: { protocolVersion: '2099-01-01' },
        });
        const result = await handleMcpRequest(req, {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
        expect((result?.result as { protocolVersion: string }).protocolVersion).toBe(
          MCP_LATEST_PROTOCOL_VERSION
        );
      });

      it('rejects an unknown older version with INVALID_PARAMS', async () => {
        const req = makeRequest({
          method: 'initialize',
          params: { protocolVersion: '2020-01-01' },
        });
        const result = await handleMcpRequest(req, {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
        expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      });

      it('rejects a non-string protocolVersion with INVALID_PARAMS', async () => {
        const req = makeRequest({
          method: 'initialize',
          params: { protocolVersion: 12345 },
        });
        const result = await handleMcpRequest(req, {
          auth,
          protocolVersion,
          serverState,
          rateLimiter,
        });
        expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      });

      it('keeps the MCP_PROTOCOL_VERSION alias pointing at the oldest supported version', () => {
        // Existing imports of MCP_PROTOCOL_VERSION in downstream code must
        // not break when we add a new spec revision.
        expect(MCP_PROTOCOL_VERSION).toBe(MCP_MIN_PROTOCOL_VERSION);
      });
    });
  });

  describe('unknown method', () => {
    it('returns METHOD_NOT_FOUND error', async () => {
      const req = makeRequest({ method: 'foobar/unknown' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.METHOD_NOT_FOUND);
      expect(result?.error?.message).toContain('foobar/unknown');
    });
  });

  describe('scope enforcement', () => {
    it('returns error when tools:list scope is missing', async () => {
      const noScope = makeAuth({ scopes: [] });
      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, {
        auth: noScope,
        protocolVersion,
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
        protocolVersion,
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
        protocolVersion,
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
        protocolVersion,
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as { tools: unknown[] };
      expect(data.tools).toHaveLength(1);
      expect((data.tools[0] as Record<string, unknown>).name).toBe('search_kb');
    });

    it('scopes the listing to the key’s agent (passes scopedAgentId to listMcpTools) (#381)', async () => {
      vi.mocked(listMcpTools).mockResolvedValue([]);
      const scopedAuth = makeAuth({ scopedAgentId: 'agent-42' });

      const req = makeRequest({ method: 'tools/list' });
      await handleMcpRequest(req, { auth: scopedAuth, protocolVersion, serverState, rateLimiter });

      // discovery must match dispatch — the list is filtered for the bound agent
      expect(listMcpTools).toHaveBeenCalledWith('agent-42');
    });

    it('passes null to listMcpTools for an unscoped key (full global list)', async () => {
      vi.mocked(listMcpTools).mockResolvedValue([]);
      const unscopedAuth = makeAuth({ scopedAgentId: null });

      const req = makeRequest({ method: 'tools/list' });
      await handleMcpRequest(req, {
        auth: unscopedAuth,
        protocolVersion,
        serverState,
        rateLimiter,
      });

      expect(listMcpTools).toHaveBeenCalledWith(null);
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error).toBeUndefined();
      expect(callMcpTool).toHaveBeenCalledWith(
        'search_kb',
        { q: 'test' },
        {
          userId: 'user-1',
          scopedAgentId: null,
        }
      );
    });

    it("forwards the key's scopedAgentId to callMcpTool so tool calls run under the scoped agent", async () => {
      vi.mocked(callMcpTool).mockResolvedValue({
        content: [{ type: 'text', text: 'result text' }],
      });

      const scopedAuth = makeAuth({ scopedAgentId: 'agent-scoped' });
      const req = makeRequest({
        method: 'tools/call',
        params: { name: 'search_kb', arguments: { q: 'test' } },
      });
      await handleMcpRequest(req, { auth: scopedAuth, protocolVersion, serverState, rateLimiter });

      expect(callMcpTool).toHaveBeenCalledWith(
        'search_kb',
        { q: 'test' },
        {
          userId: 'user-1',
          scopedAgentId: 'agent-scoped',
        }
      );
    });

    it("forwards the key's scope to callMcpTool so tool calls carry the app scope", async () => {
      vi.mocked(callMcpTool).mockResolvedValue({
        content: [{ type: 'text', text: 'result text' }],
      });

      const scopedAuth = makeAuth({ scope: { projectId: 'proj-42' } });
      const req = makeRequest({
        method: 'tools/call',
        params: { name: 'search_kb', arguments: { q: 'test' } },
      });
      await handleMcpRequest(req, { auth: scopedAuth, protocolVersion, serverState, rateLimiter });

      expect(callMcpTool).toHaveBeenCalledWith(
        'search_kb',
        { q: 'test' },
        {
          userId: 'user-1',
          scopedAgentId: null,
          scope: { projectId: 'proj-42' },
        }
      );
    });

    it('returns INVALID_PARAMS error when params are missing name', async () => {
      const req = makeRequest({ method: 'tools/call', params: {} });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });

    it('returns INVALID_PARAMS error when params are undefined', async () => {
      const req = makeRequest({ method: 'tools/call', params: undefined });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as { resourceTemplates: unknown[] };
      expect(data.resourceTemplates).toHaveLength(1);
      expect((data.resourceTemplates[0] as Record<string, unknown>).uriTemplate).toBe(
        'sunrise://knowledge/patterns/{number}'
      );
    });

    it('returns empty array when no templates exist', async () => {
      vi.mocked(listMcpResourceTemplates).mockResolvedValue([]);

      const req = makeRequest({ method: 'resources/templates/list' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as { resourceTemplates: unknown[] };
      expect(data.resourceTemplates).toEqual([]);
    });

    it('requires resources:read scope', async () => {
      const limitedAuth = makeAuth({ scopes: [McpScope.TOOLS_LIST] });
      const req = makeRequest({ method: 'resources/templates/list' });
      const result = await handleMcpRequest(req, {
        auth: limitedAuth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error).toBeDefined();
      expect(result?.error?.message).toContain('resources:read');
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
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as { contents: unknown[] };
      expect(data.contents).toHaveLength(1);
    });

    it('returns INVALID_PARAMS when resource is not found', async () => {
      vi.mocked(readMcpResource).mockResolvedValue(null);

      const req = makeRequest({ method: 'resources/read', params: { uri: 'sunrise://missing' } });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      expect(result?.error?.message).toContain('sunrise://missing');
    });

    it('returns INVALID_PARAMS when uri param is missing', async () => {
      const req = makeRequest({ method: 'resources/read', params: {} });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });
  });

  describe('prompts/list', () => {
    it('returns the prompts list', async () => {
      vi.mocked(listMcpPrompts).mockResolvedValue([
        { name: 'analyze-pattern', description: 'Analyze a pattern' },
      ]);

      const req = makeRequest({ method: 'prompts/list' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as { prompts: unknown[] };
      expect(data.prompts).toHaveLength(1);
    });
  });

  describe('prompts/get', () => {
    it('returns prompt messages for a valid prompt', async () => {
      vi.mocked(getMcpPrompt).mockResolvedValue([
        { role: 'user', content: { type: 'text', text: 'Analyze pattern #5' } },
      ]);

      const req = makeRequest({
        method: 'prompts/get',
        params: { name: 'analyze-pattern', arguments: { pattern_number: '5' } },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as { messages: unknown[] };
      expect(data.messages).toHaveLength(1);
    });

    it('returns INVALID_PARAMS when prompt name is unknown', async () => {
      vi.mocked(getMcpPrompt).mockResolvedValue(null);

      const req = makeRequest({
        method: 'prompts/get',
        params: { name: 'nonexistent-prompt' },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      expect(result?.error?.message).toContain('nonexistent-prompt');
    });

    it('returns INVALID_PARAMS when name param is missing', async () => {
      const req = makeRequest({ method: 'prompts/get', params: {} });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });

    it('maps RangeError from the registry to INVALID_PARAMS with the message', async () => {
      // The registry throws RangeError for missing required args and
      // oversized rendered output — protocol handler must surface the
      // specific message so clients see precisely what failed.
      vi.mocked(getMcpPrompt).mockRejectedValue(
        new RangeError('Missing required argument(s): pattern_number')
      );

      const req = makeRequest({
        method: 'prompts/get',
        params: { name: 'analyze-pattern', arguments: {} },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      expect(result?.error?.message).toContain('pattern_number');
    });
  });

  describe('JSON-RPC response shape', () => {
    it('success response has jsonrpc 2.0 and matching id', async () => {
      const req = makeRequest({ id: 42, method: 'ping' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.jsonrpc).toBe('2.0');
      expect(result?.id).toBe(42);
      expect(result?.result).toBeDefined();
    });

    it('error response has jsonrpc 2.0 and matching id', async () => {
      const req = makeRequest({ id: 'req-abc', method: 'unknown/method' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.jsonrpc).toBe('2.0');
      expect(result?.id).toBe('req-abc');
      expect(result?.error).toBeDefined();
    });

    it('internal errors are not leaked in error message', async () => {
      vi.mocked(listMcpTools).mockRejectedValue(new Error('DB connection string exposed'));

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toBe('Internal server error');
      expect(result?.error?.message).not.toContain('DB connection string');
    });

    it('McpProtocolError message is forwarded to client', async () => {
      vi.mocked(listMcpTools).mockRejectedValue(
        new McpProtocolError(JsonRpcErrorCode.INVALID_PARAMS, 'Bad tool params')
      );

      const req = makeRequest({ method: 'tools/list' });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toBe('Bad tool params');
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });
  });

  describe('completion/complete', () => {
    beforeEach(() => {
      vi.mocked(completeMcpReference).mockResolvedValue({
        completion: { values: ['alpha', 'beta'], hasMore: false, total: 2 },
      });
    });

    it('returns completion result for a ref/prompt with prompts:read scope', async () => {
      const req = makeRequest({
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'analyze-pattern' },
          argument: { name: 'pattern_number', value: '1' },
        },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error).toBeUndefined();
      expect((result?.result as { completion: { total: number } }).completion.total).toBe(2);
    });

    it('blocks ref/prompt without prompts:read scope', async () => {
      const noPromptsScope = makeAuth({
        scopes: [McpScope.TOOLS_LIST, McpScope.RESOURCES_READ],
      });
      const req = makeRequest({
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'p' },
          argument: { name: 'x', value: '' },
        },
      });
      const result = await handleMcpRequest(req, {
        auth: noPromptsScope,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toContain('prompts:read');
    });

    it('blocks ref/resource without resources:read scope', async () => {
      const noResScope = makeAuth({ scopes: [McpScope.PROMPTS_READ] });
      const req = makeRequest({
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/resource', uri: 'sunrise://x' },
          argument: { name: 'x', value: '' },
        },
      });
      const result = await handleMcpRequest(req, {
        auth: noResScope,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.message).toContain('resources:read');
    });

    it('rejects ref with unknown type', async () => {
      const req = makeRequest({
        method: 'completion/complete',
        params: { ref: { type: 'ref/nonsense' }, argument: { name: 'x', value: '' } },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });

    it('rejects malformed argument', async () => {
      const req = makeRequest({
        method: 'completion/complete',
        params: { ref: { type: 'ref/prompt', name: 'p' }, argument: 'not-an-object' },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
    });

    it('maps RangeError from the registry to INVALID_PARAMS', async () => {
      vi.mocked(completeMcpReference).mockRejectedValueOnce(
        new RangeError('argument value exceeds 1024 char limit')
      );
      const req = makeRequest({
        method: 'completion/complete',
        params: {
          ref: { type: 'ref/prompt', name: 'p' },
          argument: { name: 'x', value: 'too long' },
        },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      expect(result?.error?.code).toBe(JsonRpcErrorCode.INVALID_PARAMS);
      expect(result?.error?.message).toContain('1024');
    });
  });

  describe('initialize advertises completions', () => {
    it('includes completions:{} in capabilities', async () => {
      const req = makeRequest({
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      });
      const result = await handleMcpRequest(req, {
        auth,
        protocolVersion,
        serverState,
        rateLimiter,
      });
      const data = result?.result as {
        capabilities: { completions?: Record<string, never> };
      };
      expect(data.capabilities.completions).toEqual({});
    });
  });
});

// ─── One transport, and what went with the other one (§39 t-718) ─────────────

describe('the three methods that needed a session are gone', () => {
  let auth: McpAuthContext;
  let serverState: McpServerState;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;

  beforeEach(() => {
    vi.clearAllMocks();
    auth = makeAuth();
    serverState = makeServerState();
    rateLimiter = makeRateLimiter();
  });

  const context = () => ({
    auth,
    protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
    serverState,
    rateLimiter,
  });

  /**
   * METHOD_NOT_FOUND, not the old `STATELESS_UNSUPPORTED`.
   *
   * That code said "the method exists, the topology cannot carry it", which was
   * true while one of the two transports could. Neither can now, so the honest
   * answer is the one every other unimplemented method gets — and a client
   * reading it looks for a version mismatch, which is exactly what it has: these
   * three are pre-2026-07-28 methods. The code itself is gone from
   * `JsonRpcErrorCode`, so this cannot be re-asserted by accident.
   */
  it.each([
    ['resources/subscribe', { uri: 'sunrise://agents' }],
    ['resources/unsubscribe', { uri: 'sunrise://agents' }],
    ['logging/setLevel', { level: 'debug' }],
  ])('%s answers METHOD_NOT_FOUND', async (method, params) => {
    const result = await handleMcpRequest(makeRequest({ id: 1, method, params }), context());

    expect(result?.error?.code).toBe(JsonRpcErrorCode.METHOD_NOT_FOUND);
    expect(result?.error?.message).toContain(method);
  });

  /**
   * The counterpart, or the assertion above would pass against a dispatcher
   * that had lost the methods it still has.
   */
  it('still dispatches the methods that never needed a session', async () => {
    vi.mocked(listMcpTools).mockResolvedValue([]);
    const result = await handleMcpRequest(makeRequest({ id: 1, method: 'tools/list' }), context());

    expect(result?.error).toBeUndefined();
  });

  /**
   * `_meta.progressToken` used to be shape-validated, so a malformed one got
   * INVALID_PARAMS. Nothing can send a progress notification any more, so the
   * field is ignored — the same rule the 2026-07-28 revision states for a
   * stray `Mcp-Session-Id`: ignore what you no longer honour rather than
   * refusing the request carrying it. Refusing a tool call over a field we
   * discard would fail work for no gain.
   */
  it.each([
    ['an object', { x: 1 }],
    ['an over-long string', 'x'.repeat(257)],
  ])(
    'ignores %s progressToken on tools/call rather than refusing the call',
    async (_label, token) => {
      vi.mocked(callMcpTool).mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      const req = makeRequest({
        id: 1,
        method: 'tools/call',
        params: { name: 'tool', _meta: { progressToken: token } },
      });

      const result = await handleMcpRequest(req, context());

      expect(result?.error).toBeUndefined();
      expect(callMcpTool).toHaveBeenCalled();
    }
  );
});

describe('tool annotations are gated on the version the CALLER declared', () => {
  // The one branch this change rewired: `emitAnnotations` used to read
  // `session.protocolVersion` off a stored session and now reads
  // `context.protocolVersion`, resolved per request from the
  // `MCP-Protocol-Version` header. Nothing exercised it as FALSE — every call in
  // this file passes the latest version, and no assertion in it mentioned
  // `annotations` at all. The route test proves the header resolves correctly and
  // `tool-registry.test.ts` proves annotations are produced, but nothing joined
  // them, so hard-wiring this to the latest version (or deleting the gate) left
  // the whole suite green while a 2024-11-05 client silently received a field it
  // never negotiated.
  let auth: McpAuthContext;
  let serverState: McpServerState;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;

  const ANNOTATED = {
    slug: 'search_kb',
    name: 'search_kb',
    description: 'Search',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    auth = makeAuth();
    serverState = makeServerState();
    rateLimiter = makeRateLimiter();
    vi.mocked(listMcpTools).mockResolvedValue([ANNOTATED]);
  });

  async function firstToolAt(
    protocolVersion: McpProtocolVersion
  ): Promise<Record<string, unknown>> {
    const result = await handleMcpRequest(makeRequest({ id: 1, method: 'tools/list' }), {
      auth,
      protocolVersion,
      serverState,
      rateLimiter,
    });
    return (result?.result as { tools: Record<string, unknown>[] }).tools[0];
  }

  it('emits annotations at 2025-06-18, the revision that introduced them', async () => {
    expect(await firstToolAt('2025-06-18')).toHaveProperty('annotations', ANNOTATED.annotations);
  });

  it('WITHHOLDS them at 2024-11-05, which never agreed to the field', async () => {
    // The half that could not fail before. `not.toHaveProperty` rather than an
    // undefined check: the field is spread in conditionally, so it must be
    // absent from the object, not present-and-undefined.
    expect(await firstToolAt('2024-11-05')).not.toHaveProperty('annotations');
  });

  it('still returns the tool itself at the older version', async () => {
    // The control. Without it the assertion above would pass against a
    // `tools/list` that had stopped returning anything.
    expect(await firstToolAt('2024-11-05')).toMatchObject({ name: 'search_kb' });
  });
});

describe('initialize advertises nothing it cannot deliver', () => {
  let auth: McpAuthContext;
  let serverState: McpServerState;
  let rateLimiter: ReturnType<typeof makeRateLimiter>;

  beforeEach(() => {
    auth = makeAuth();
    serverState = makeServerState();
    rateLimiter = makeRateLimiter();
  });

  it('withholds subscribe, listChanged and logging — there is no way to push', async () => {
    const req = makeRequest({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'c', version: '1' },
      },
    });

    const result = await handleMcpRequest(req, {
      auth,
      protocolVersion: MCP_LATEST_PROTOCOL_VERSION,
      serverState,
      rateLimiter,
    });

    // `toEqual` is exact-shape on purpose: an accidental re-addition of
    // `listChanged`, `subscribe` or `logging` fails here rather than being
    // absorbed. Each was a promise to send the client something later, and
    // there is no later.
    expect((result?.result as { capabilities: Record<string, unknown> }).capabilities).toEqual({
      tools: {},
      resources: {},
      prompts: {},
      completions: {},
    });
  });
});
