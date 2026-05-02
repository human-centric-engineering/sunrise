/**
 * Tests for `CallExternalApiCapability`.
 *
 * The capability composes the shared HTTP module + a per-agent
 * `customConfig` row. We mock prisma + global fetch but exercise the
 * real HTTP module — that gives us coverage of the URL-prefix guard,
 * forced-header merge, auto-idempotency, response-transform fallback,
 * and the HttpError → CapabilityResult code mapping.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgentCapability: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { prisma } = await import('@/lib/db/client');
const { CallExternalApiCapability } =
  await import('@/lib/orchestration/capabilities/built-in/call-external-api');
const { resetAllowlistCache } = await import('@/lib/orchestration/http/allowlist');
const { resetOutboundRateLimiters } =
  await import('@/lib/orchestration/engine/outbound-rate-limiter');

const findFirst = prisma.aiAgentCapability.findFirst as ReturnType<typeof vi.fn>;

const context = { userId: 'user-1', agentId: 'agent-1' };
const originalEnv = process.env;

function bindCustomConfig(config: unknown): void {
  findFirst.mockResolvedValue({ customConfig: config });
}

function noBinding(): void {
  findFirst.mockResolvedValue(null);
}

function mockFetchJson(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllowlistCache();
  resetOutboundRateLimiters();
  process.env = {
    ...originalEnv,
    ORCHESTRATION_ALLOWED_HOSTS: 'api.allowed.com',
  };
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

describe('CallExternalApiCapability', () => {
  describe('args validation', () => {
    it('accepts missing url at the schema layer (forcedUrl in binding may supply it)', () => {
      const cap = new CallExternalApiCapability();
      // Zod allows it; execute() returns invalid_args if no forcedUrl either.
      expect(() => cap.validate({ method: 'POST' })).not.toThrow();
    });

    it('returns invalid_args at execute when neither url nor forcedUrl is supplied', async () => {
      noBinding();
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ method: 'POST' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_args');
    });

    it('rejects missing method', () => {
      const cap = new CallExternalApiCapability();
      expect(() => cap.validate({ url: 'https://api.allowed.com/x' })).toThrow();
    });

    it('rejects non-URL strings', () => {
      const cap = new CallExternalApiCapability();
      expect(() => cap.validate({ url: 'not-a-url', method: 'GET' })).toThrow();
    });

    it('rejects unknown HTTP methods', () => {
      const cap = new CallExternalApiCapability();
      expect(() => cap.validate({ url: 'https://api.allowed.com/x', method: 'TRACE' })).toThrow();
    });

    it('accepts a valid args object', () => {
      const cap = new CallExternalApiCapability();
      const args = cap.validate({
        url: 'https://api.allowed.com/x',
        method: 'POST',
        body: { hello: 'world' },
      });
      expect(args.url).toBe('https://api.allowed.com/x');
      expect(args.body).toEqual({ hello: 'world' });
    });
  });

  describe('happy path (no binding)', () => {
    it('calls the URL and returns status + body', async () => {
      noBinding();
      mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/v1/x', method: 'POST', body: { a: 1 } },
        context
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ status: 200, body: { ok: true } });
    });

    it('JSON-stringifies object bodies', async () => {
      noBinding();
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: { amount: 100 } },
        context
      );
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.body).toBe('{"amount":100}');
    });

    it('passes string bodies through verbatim', async () => {
      noBinding();
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: 'raw=body&form=encoded' },
        context
      );
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.body).toBe('raw=body&form=encoded');
    });
  });

  describe('URL prefix restriction', () => {
    it('rejects URLs outside allowedUrlPrefixes', async () => {
      bindCustomConfig({
        allowedUrlPrefixes: ['https://api.allowed.com/v1/email'],
      });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/v1/admin/destroy', method: 'POST' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('url_not_allowed');
    });

    it('allows URLs that match a prefix', async () => {
      bindCustomConfig({
        allowedUrlPrefixes: ['https://api.allowed.com/v1/email'],
      });
      mockFetchJson(200, { id: 'msg_1' });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/v1/email/send', method: 'POST', body: {} },
        context
      );
      expect(result.success).toBe(true);
    });
  });

  describe('forcedUrl', () => {
    it('overrides args.url with the binding-pinned URL', async () => {
      bindCustomConfig({ forcedUrl: 'https://api.allowed.com/v1/notify' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        { url: 'https://api.allowed.com/v1/anything-else', method: 'POST', body: {} },
        context
      );
      const calledUrl = fetchSpy.mock.calls[0]?.[0];
      expect(calledUrl).toBe('https://api.allowed.com/v1/notify');
    });

    it('accepts a tool call with no url when forcedUrl is set', async () => {
      bindCustomConfig({ forcedUrl: 'https://api.allowed.com/v1/notify' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ method: 'POST', body: { msg: 'hi' } }, context);
      expect(result.success).toBe(true);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.allowed.com/v1/notify');
    });

    it('forcedUrl bypasses allowedUrlPrefixes (it IS the constraint)', async () => {
      bindCustomConfig({
        forcedUrl: 'https://api.allowed.com/v1/notify',
        allowedUrlPrefixes: ['https://api.allowed.com/v1/something-else'],
      });
      mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ method: 'POST', body: {} }, context);
      expect(result.success).toBe(true);
    });
  });

  describe('per-agent auth from customConfig', () => {
    it('uses bearer auth from binding (not from args)', async () => {
      process.env.MY_API_TOKEN = 'sk_test_xyz';
      bindCustomConfig({
        auth: { type: 'bearer', secret: 'MY_API_TOKEN' },
      });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute({ url: 'https://api.allowed.com/x', method: 'POST', body: {} }, context);
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBe('Bearer sk_test_xyz');
    });

    it('returns auth_failed when the env var is unset', async () => {
      delete process.env.MISSING_VAR;
      bindCustomConfig({
        auth: { type: 'bearer', secret: 'MISSING_VAR' },
      });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('auth_failed');
    });

    it('isolates auth between agents — different bindings → different env vars', async () => {
      process.env.AGENT_A_TOKEN = 'token_a';
      process.env.AGENT_B_TOKEN = 'token_b';

      // Agent A: bound to AGENT_A_TOKEN.
      findFirst.mockResolvedValueOnce({
        customConfig: { auth: { type: 'bearer', secret: 'AGENT_A_TOKEN' } },
      });
      const fetchA = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        { userId: 'u', agentId: 'agent-a' }
      );
      const authA = ((fetchA.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)
        .Authorization;
      expect(authA).toBe('Bearer token_a');

      vi.restoreAllMocks();

      // Agent B: bound to AGENT_B_TOKEN.
      findFirst.mockResolvedValueOnce({
        customConfig: { auth: { type: 'bearer', secret: 'AGENT_B_TOKEN' } },
      });
      const fetchB = mockFetchJson(200, { ok: true });
      await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        { userId: 'u', agentId: 'agent-b' }
      );
      const authB = ((fetchB.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)
        .Authorization;
      expect(authB).toBe('Bearer token_b');
    });
  });

  describe('forced headers and idempotency', () => {
    it('forcedHeaders override headers from args', async () => {
      bindCustomConfig({
        forcedHeaders: { 'X-Vendor': 'sunrise', Accept: 'application/json' },
      });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        {
          url: 'https://api.allowed.com/x',
          method: 'POST',
          headers: { 'X-Vendor': 'caller-supplied', Accept: 'text/plain' },
          body: {},
        },
        context
      );
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['X-Vendor']).toBe('sunrise');
      expect(headers.Accept).toBe('application/json');
    });

    it('forcedHeaders override LLM headers regardless of case (closes smuggling path)', async () => {
      // Security regression: previously a plain JS spread let a lowercase
      // `authorization` from the LLM coexist alongside a canonical
      // `Authorization` from forcedHeaders. fetch's Headers constructor
      // would then concatenate the two as a single comma-separated value.
      bindCustomConfig({
        forcedHeaders: { Authorization: 'Bearer admin-controlled' },
      });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        {
          url: 'https://api.allowed.com/x',
          method: 'POST',
          headers: { authorization: 'Bearer attacker' },
          body: {},
        },
        context
      );
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      const authEntries = Object.entries(headers).filter(
        ([k]) => k.toLowerCase() === 'authorization'
      );
      expect(authEntries).toHaveLength(1);
      expect(authEntries[0]?.[1]).toBe('Bearer admin-controlled');
    });

    it('autoIdempotency injects an Idempotency-Key header', async () => {
      bindCustomConfig({ autoIdempotency: true });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        { url: 'https://api.allowed.com/charge', method: 'POST', body: {} },
        context
      );
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('honours custom idempotencyHeader name', async () => {
      bindCustomConfig({ autoIdempotency: true, idempotencyHeader: 'X-Idempotent' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        { url: 'https://api.allowed.com/charge', method: 'POST', body: {} },
        context
      );
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['X-Idempotent']).toBeTruthy();
      expect(headers['Idempotency-Key']).toBeUndefined();
    });
  });

  describe('response transform fallback', () => {
    it('uses the binding default transform when caller does not supply one', async () => {
      bindCustomConfig({
        defaultResponseTransform: { type: 'jmespath', expression: 'data.id' },
      });
      mockFetchJson(200, { data: { id: 'msg_42' } });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        context
      );
      expect(result.data?.body).toBe('msg_42');
    });

    it('caller-supplied responseExtract overrides the binding default', async () => {
      bindCustomConfig({
        defaultResponseTransform: { type: 'jmespath', expression: 'data.id' },
      });
      mockFetchJson(200, { data: { id: 'msg_42', name: 'Alice' } });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        {
          url: 'https://api.allowed.com/x',
          method: 'POST',
          body: {},
          responseExtract: 'data.name',
        },
        context
      );
      expect(result.data?.body).toBe('Alice');
    });
  });

  describe('error mapping', () => {
    it('maps allowlist rejection to host_not_allowed', async () => {
      noBinding();
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ url: 'https://evil.com/x', method: 'GET' }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('host_not_allowed');
    });

    it('maps non-2xx to http_error', async () => {
      noBinding();
      mockFetchJson(400, 'bad request');
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'GET' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('http_error');
      expect(result.error?.message).toContain('400');
    });

    it('maps response_too_large via the body cap', async () => {
      bindCustomConfig({ maxResponseBytes: 10 });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('x'.repeat(100), {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        })
      );
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'GET' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('response_too_large');
    });
  });

  describe('malformed customConfig', () => {
    it('falls back to no-binding behaviour when customConfig fails Zod', async () => {
      bindCustomConfig({ allowedUrlPrefixes: 'not-an-array' });
      mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        context
      );
      // No URL-prefix guard, no auth — request still goes through.
      expect(result.success).toBe(true);
    });
  });
});
