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

    it('maps a 503 response to http_error (retriable HttpError variant)', async () => {
      noBinding();
      mockFetchJson(503, 'service unavailable');
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'GET' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('http_error');
    });

    it('maps a network failure to request_failed', async () => {
      noBinding();
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('econnrefused'));
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'GET' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('request_failed');
    });

    it('maps a fetch timeout (AbortError) to timeout', async () => {
      noBinding();
      // Mock fetch to honour the AbortSignal it's handed by the HTTP module's
      // internal AbortController. With timeoutMs=10, the controller aborts
      // before the mocked fetch resolves.
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) =>
          new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          })
      );
      bindCustomConfig({ timeoutMs: 10 });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'GET' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('timeout');
    });

    it('maps an outbound rate-limit hit to rate_limited', async () => {
      // Drive the limiter to allowed=false by setting the env var to 1
      // request/min, then issuing two calls.
      process.env.ORCHESTRATION_OUTBOUND_RATE_LIMIT = '1';
      resetOutboundRateLimiters();
      noBinding();
      mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      // First call consumes the per-minute budget.
      await cap.execute({ url: 'https://api.allowed.com/x', method: 'GET' }, context);
      // Second call should hit the rate limit.
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'GET' },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('rate_limited');
    });
  });

  describe('response transform error surfaced on success result', () => {
    it('returns success: true with body + transformError when defaultResponseTransform throws', async () => {
      bindCustomConfig({
        defaultResponseTransform: { type: 'jmespath', expression: 'invalid syntax !!!' },
      });
      mockFetchJson(200, { user: { id: 'u1' } });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'GET' },
        context
      );
      expect(result.success).toBe(true);
      expect(result.data?.body).toEqual({ user: { id: 'u1' } });
      expect(result.data?.transformError).toBeTruthy();
    });
  });

  describe('malformed customConfig (fail-closed)', () => {
    it('refuses the call with invalid_binding when customConfig fails Zod', async () => {
      // Security: silently downgrading to no-binding behaviour when the
      // JSON column is malformed would let the LLM call any path on the
      // allowlisted host with no auth — for chat-webhook bindings where
      // the URL itself is the credential, that's a real exfiltration
      // path. Refuse the call until an admin repairs the column.
      bindCustomConfig({ allowedUrlPrefixes: 'not-an-array' });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
    });

    it('does not even attempt the HTTP request when customConfig is malformed', async () => {
      bindCustomConfig({ allowedUrlPrefixes: 'not-an-array' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute({ url: 'https://api.allowed.com/x', method: 'POST', body: {} }, context);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('env-var template substitution', () => {
    it('resolves ${env:VAR} in forcedUrl at call time', async () => {
      process.env.SLACK_WEBHOOK_URL = 'https://api.allowed.com/v1/services/T/B/X';
      bindCustomConfig({ forcedUrl: '${env:SLACK_WEBHOOK_URL}' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ method: 'POST', body: { msg: 'hi' } }, context);
      expect(result.success).toBe(true);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://api.allowed.com/v1/services/T/B/X');
    });

    it('resolves ${env:VAR} in forcedHeaders at call time', async () => {
      process.env.MY_BEARER = 'admin-controlled-token';
      bindCustomConfig({
        forcedHeaders: { Authorization: 'Bearer ${env:MY_BEARER}' },
      });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute({ url: 'https://api.allowed.com/x', method: 'POST', body: {} }, context);
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBe('Bearer admin-controlled-token');
    });

    it('resolves multiple ${env:VAR} references inside a single forcedUrl', async () => {
      process.env.SLACK_TEAM = 'TEAM123';
      process.env.SLACK_HOOK = 'HOOK456';
      bindCustomConfig({
        forcedUrl: 'https://api.allowed.com/services/${env:SLACK_TEAM}/${env:SLACK_HOOK}/x',
      });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute({ method: 'POST', body: {} }, context);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        'https://api.allowed.com/services/TEAM123/HOOK456/x'
      );
    });

    it('returns invalid_binding when forcedUrl references an unset env var', async () => {
      delete process.env.MISSING_WEBHOOK;
      bindCustomConfig({ forcedUrl: '${env:MISSING_WEBHOOK}' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ method: 'POST', body: {} }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
      expect(result.error?.message).toContain('MISSING_WEBHOOK');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns invalid_binding when a forcedHeaders value references an unset env var', async () => {
      delete process.env.MISSING_TOKEN;
      bindCustomConfig({
        forcedHeaders: { Authorization: 'Bearer ${env:MISSING_TOKEN}' },
      });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        { url: 'https://api.allowed.com/x', method: 'POST', body: {} },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns invalid_binding when forcedUrl resolves to a non-URL string', async () => {
      process.env.NOT_A_URL = 'just some text';
      bindCustomConfig({ forcedUrl: '${env:NOT_A_URL}' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ method: 'POST', body: {} }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('schema accepts forcedUrl with an env-template literal (was previously .url()-rejected)', async () => {
      // Validate via the test-only export rather than relying on
      // execute() so the schema-layer behaviour is asserted directly.
      const { __testing } =
        await import('@/lib/orchestration/capabilities/built-in/call-external-api');
      const result = __testing.customConfigSchema.safeParse({
        forcedUrl: '${env:SLACK_WEBHOOK_URL}',
      });
      expect(result.success).toBe(true);
    });

    it('schema still rejects a non-URL literal that contains no env template', async () => {
      const { __testing } =
        await import('@/lib/orchestration/capabilities/built-in/call-external-api');
      const result = __testing.customConfigSchema.safeParse({ forcedUrl: 'not-a-url' });
      expect(result.success).toBe(false);
    });

    it('host-allowlist runs on the RESOLVED url, so env vars cannot bypass ORCHESTRATION_ALLOWED_HOSTS', async () => {
      // If an admin sets `forcedUrl: "${env:ENDPOINT}"` and the env
      // value points at a host NOT in the allowlist, the call must be
      // rejected with host_not_allowed — env substitution is not an
      // allowlist bypass. (This is enforced by the shared HTTP module
      // running the allowlist check on the URL it actually fetches,
      // which is the resolved one.)
      process.env.OFF_ALLOWLIST = 'https://evil.example.com/x';
      bindCustomConfig({ forcedUrl: '${env:OFF_ALLOWLIST}' });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute({ method: 'POST', body: {} }, context);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('host_not_allowed');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does NOT env-substitute LLM-supplied args.url (only forcedUrl/forcedHeaders are templated)', async () => {
      // The LLM arg path is intentionally outside env-template scope.
      // If an LLM puts ${env:SECRET} in args.url, it must be sent
      // verbatim — the env resolver must never give an LLM a way to
      // read env vars by stuffing template syntax into a tool call.
      process.env.LLM_PROBE_SECRET = 'should-not-leak';
      bindCustomConfig({ allowedUrlPrefixes: ['https://api.allowed.com/path/'] });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        {
          url: 'https://api.allowed.com/path/${env:LLM_PROBE_SECRET}',
          method: 'POST',
          body: {},
        },
        context
      );
      const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(calledUrl).toContain('${env:LLM_PROBE_SECRET}');
      expect(calledUrl).not.toContain('should-not-leak');
    });

    it('does NOT env-substitute LLM-supplied args.headers either', async () => {
      process.env.LLM_PROBE_HDR_SECRET = 'should-not-leak';
      noBinding();
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        {
          url: 'https://api.allowed.com/x',
          method: 'POST',
          headers: { 'X-LLM-Set': 'Bearer ${env:LLM_PROBE_HDR_SECRET}' },
          body: {},
        },
        context
      );
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['X-LLM-Set']).toBe('Bearer ${env:LLM_PROBE_HDR_SECRET}');
      expect(headers['X-LLM-Set']).not.toContain('should-not-leak');
    });
  });

  describe('multipart/form-data', () => {
    const helloBase64 = Buffer.from('<html>hi</html>').toString('base64');

    it('schema rejects body and multipart together', async () => {
      const cap = new CallExternalApiCapability();
      // BaseCapability.validate wraps Zod failures with a generic
      // message; checking via the test-only schema export gets at the
      // refine's actual message.
      expect(() =>
        cap.validate({
          url: 'https://api.allowed.com/x',
          method: 'POST',
          body: { foo: 'bar' },
          multipart: {
            files: [{ name: 'index.html', contentType: 'text/html', data: helloBase64 }],
          },
        })
      ).toThrow();
      const { __testing } =
        await import('@/lib/orchestration/capabilities/built-in/call-external-api');
      const result = __testing.argsSchema.safeParse({
        url: 'https://api.allowed.com/x',
        method: 'POST',
        body: { foo: 'bar' },
        multipart: {
          files: [{ name: 'index.html', contentType: 'text/html', data: helloBase64 }],
        },
      });
      expect(result.success).toBe(false);
      const issue = result.success ? undefined : result.error.issues[0];
      expect(issue?.message).toMatch(/mutually exclusive/);
    });

    it('schema accepts a multipart-only call', () => {
      const cap = new CallExternalApiCapability();
      expect(() =>
        cap.validate({
          url: 'https://api.allowed.com/forms',
          method: 'POST',
          multipart: {
            files: [{ name: 'index.html', contentType: 'text/html', data: helloBase64 }],
            fields: { paperWidth: '8.5' },
          },
        })
      ).not.toThrow();
    });

    it('passes a FormData body to fetch when multipart is supplied', async () => {
      noBinding();
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        {
          url: 'https://api.allowed.com/forms/chromium/convert/html',
          method: 'POST',
          multipart: {
            files: [{ name: 'index.html', contentType: 'text/html', data: helloBase64 }],
            fields: { paperWidth: '8.5' },
          },
        },
        context
      );
      const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
      expect(init.body).toBeInstanceOf(FormData);
      expect((init.body as FormData).get('paperWidth')).toBe('8.5');
      expect((init.body as FormData).get('index.html')).toBeInstanceOf(File);
    });

    it('omits Content-Type: application/json when multipart is supplied (undici sets boundary)', async () => {
      noBinding();
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        {
          url: 'https://api.allowed.com/forms',
          method: 'POST',
          multipart: {
            files: [{ name: 'doc', contentType: 'application/octet-stream', data: helloBase64 }],
          },
        },
        context
      );
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers['Content-Type']).toBeUndefined();
    });

    it('returns invalid_args when multipart contains non-base64 data', async () => {
      noBinding();
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        {
          url: 'https://api.allowed.com/forms',
          method: 'POST',
          multipart: {
            files: [{ name: 'doc', contentType: 'text/plain', data: 'not really base64 !!!' }],
          },
        },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_args');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('surfaces multipart_hmac_unsupported as invalid_binding when admin pairs HMAC with a multipart call', async () => {
      process.env.HMAC_KEY = 'secret';
      bindCustomConfig({ auth: { type: 'hmac', secret: 'HMAC_KEY' } });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      const result = await cap.execute(
        {
          url: 'https://api.allowed.com/forms',
          method: 'POST',
          multipart: {
            files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
          },
        },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('invalid_binding');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still applies non-HMAC auth alongside multipart', async () => {
      process.env.UPLOAD_TOKEN = 'tok_abc';
      bindCustomConfig({ auth: { type: 'bearer', secret: 'UPLOAD_TOKEN' } });
      const fetchSpy = mockFetchJson(200, { ok: true });
      const cap = new CallExternalApiCapability();
      await cap.execute(
        {
          url: 'https://api.allowed.com/forms',
          method: 'POST',
          multipart: {
            files: [{ name: 'doc', contentType: 'text/plain', data: helloBase64 }],
          },
        },
        context
      );
      const headers = (fetchSpy.mock.calls[0]?.[1] as RequestInit).headers as Record<
        string,
        string
      >;
      expect(headers.Authorization).toBe('Bearer tok_abc');
    });
  });
});
