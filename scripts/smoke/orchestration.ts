/* eslint-disable no-console -- CLI smoke script */
/**
 * Orchestration admin-API smoke script
 *
 * End-to-end CHECKPOINT for Phase 3 of the orchestration layer. Drives the
 * real dev server via HTTP, with a mock OpenAI-compatible LLM server stood
 * up in-process on a random free port. No API keys, no network, no cost.
 *
 * Exercises (across all three Phase 3 sessions):
 *   - 3.1  agents + capabilities CRUD, pivot attach
 *   - 3.2  providers CRUD (seeds the mock-backed provider), workflows CRUD +
 *          validate, executions 501 stub
 *   - 3.3  streaming chat (ReadableStream), knowledge upload + search,
 *          conversations list + clear (ownership-scoped)
 *   - 3.4  costs breakdown / summary / alerts, agents/[id]/budget,
 *          evaluations CRUD + complete (AI analysis through mock server)
 *
 * Flow:
 *   1. Spin up mock OpenAI-compatible HTTP server on a free loopback port
 *   2. Sign up a throwaway admin via /api/auth/sign-up/email → get session cookie
 *   3. Upgrade the user's role to ADMIN via prisma (dev convenience)
 *   4. Seed AiProviderConfig (isLocal: true, baseUrl → mock server)
 *   5. Walk the admin API with `fetch`, asserting each slice
 *   6. Verify AiCostLog persistence via prisma
 *   7. Clean up every row the script created (scoped by smoke prefix)
 *
 * Safety:
 *   - Every row is scoped by `smoke-test-orch-*` prefixes. Cleanup deletes
 *     only those rows. Never uses `deleteMany({})` or touches other data.
 *   - The mock server only binds to 127.0.0.1 on a kernel-assigned port.
 *   - Requires the dev server to be running. Default target is
 *     http://localhost:3001 (override with SMOKE_BASE_URL).
 *
 * Run with:
 *   npm run dev                                # in another terminal
 *   npm run smoke:orchestration                # or tsx directly:
 *   npx tsx --env-file=.env.local scripts/smoke/orchestration.ts
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { prisma } from '@/lib/db/client';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3001';
const SMOKE_PREFIX = 'smoke-test-orch';
const ADMIN_EMAIL = `${SMOKE_PREFIX}-admin-${Date.now()}@example.com`;
const ADMIN_PASSWORD = 'SmokeTest1234!';
const ADMIN_NAME = 'Smoke Orch Admin';
const PROVIDER_SLUG = `${SMOKE_PREFIX}-provider`;
const AGENT_SLUG = `${SMOKE_PREFIX}-agent`;
const CAPABILITY_SLUG = `${SMOKE_PREFIX}-capability`;
const WORKFLOW_SLUG = `${SMOKE_PREFIX}-workflow`;

const MOCK_MARKDOWN = `# Smoke Test Document

This is a throwaway markdown file used by scripts/smoke/orchestration.ts to
exercise the knowledge-base ingestion pipeline end-to-end.

## Section A — Patterns

The **reflection pattern** asks an agent to critique its own output. It is
one of the most widely applicable agentic patterns and costs little beyond a
second inference call.

## Section B — Costs

Token usage tracking is essential for production agents. Every capability
call, chat turn, and evaluation run should emit an AiCostLog row.
`;

// ────────────────────────────────────────────────────────────────────────────
// Minimal assertion + reporting helpers
// ────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function checkRes(label: string, res: ApiResponse, expectedStatus: number): boolean {
  const ok = res.status === expectedStatus;
  if (ok) {
    passed++;
    console.log(`    ✓ ${label}`);
  } else {
    failed++;
    const preview = JSON.stringify(res.body).slice(0, 180);
    console.log(`    ✗ ${label} — expected ${expectedStatus} got ${res.status}: ${preview}`);
  }
  return ok;
}

function section(n: number, label: string): void {
  console.log(`\n[${n}] ${label}`);
}

// ────────────────────────────────────────────────────────────────────────────
// Mock OpenAI-compatible HTTP server
// ────────────────────────────────────────────────────────────────────────────

interface MockServerState {
  url: string;
  chatCalls: number;
  embedCalls: number;
  close: () => Promise<void>;
}

async function startMockServer(): Promise<MockServerState> {
  const state = { chatCalls: 0, embedCalls: 0 };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (req.method === 'GET' && url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ id: 'smoke-mock-model', object: 'model', owned_by: 'smoke' }],
          })
        );
        return;
      }

      if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
        state.chatCalls++;
        let payload: { stream?: boolean; messages?: Array<{ role: string; content: string }> } = {};
        try {
          payload = JSON.parse(body) as typeof payload;
        } catch {
          /* ignore */
        }
        // Respond with a JSON-shaped reply so the evaluation parser accepts it.
        const reply =
          '{"summary": "Mock summary.", "improvementSuggestions": ["Be more concise."]}';

        if (payload.stream) {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          const chunks = [
            {
              id: 'chatcmpl-smoke-1',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'smoke-mock-model',
              choices: [
                { index: 0, delta: { role: 'assistant', content: 'Mock ' }, finish_reason: null },
              ],
            },
            {
              id: 'chatcmpl-smoke-1',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'smoke-mock-model',
              choices: [{ index: 0, delta: { content: 'reply.' }, finish_reason: null }],
            },
            {
              id: 'chatcmpl-smoke-1',
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'smoke-mock-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
            },
          ];
          for (const c of chunks) {
            res.write(`data: ${JSON.stringify(c)}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-smoke-1',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'smoke-mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: reply },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 42, total_tokens: 162 },
          })
        );
        return;
      }

      if (req.method === 'POST' && url.startsWith('/v1/embeddings')) {
        state.embedCalls++;
        let payload: { input?: string | string[] } = {};
        try {
          payload = JSON.parse(body) as typeof payload;
        } catch {
          /* ignore */
        }
        const inputs = Array.isArray(payload.input) ? payload.input : [payload.input ?? ''];
        // Deterministic non-zero 1536-dim vector per input — good enough for
        // the pgvector insert contract. No cosine realism required.
        const data = inputs.map((_, index) => ({
          object: 'embedding',
          index,
          embedding: Array.from({ length: 1536 }, (_, i) => ((i + index + 1) % 10) / 10),
        }));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            object: 'list',
            data,
            model: 'smoke-mock-embeddings',
            usage: { prompt_tokens: 10, total_tokens: 10 },
          })
        );
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found in mock server' } }));
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    get url() {
      return url;
    },
    get chatCalls() {
      return state.chatCalls;
    },
    get embedCalls() {
      return state.embedCalls;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP helper (cookie-authenticated fetch with a tiny response envelope)
// ────────────────────────────────────────────────────────────────────────────

interface ApiResponse<T = unknown> {
  status: number;
  ok: boolean;
  body: T;
  raw: Response;
}

function buildClient(cookie: string) {
  return async function call<T = unknown>(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {}
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      cookie,
      origin: BASE_URL,
      accept: 'application/json',
      ...init.headers,
    };
    let bodyInit: BodyInit | undefined;
    if (init.body instanceof FormData) {
      bodyInit = init.body;
    } else if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      bodyInit = JSON.stringify(init.body);
    }
    const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: bodyInit });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON response (e.g. SSE or 500 HTML) */
    }
    return { status: res.status, ok: res.ok, body: body as T, raw: res };
  };
}

/**
 * Poll a URL until it returns one of the expected status codes or we hit
 * the retry budget. Used as a dev-server warm-up (Turbopack compiles
 * routes on first request, so the first hit can 404).
 */
async function waitForRoute(
  url: string,
  expectedStatuses: number[],
  { attempts = 30, delayMs = 500 }: { attempts?: number; delayMs?: number } = {}
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { headers: { origin: BASE_URL } });
      if (expectedStatuses.includes(res.status)) return;
      // Drain the body so the connection is reusable.
      await res.text().catch(() => undefined);
    } catch {
      /* connection refused — dev server still booting */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `${url} never returned one of [${expectedStatuses.join(',')}] within ${attempts * delayMs}ms — is the dev server running?`
  );
}

function extractSessionCookie(setCookieHeaders: string[]): string | null {
  for (const raw of setCookieHeaders) {
    const firstPart = raw.split(';', 1)[0] ?? '';
    if (firstPart.includes('better-auth.session_token=')) {
      return firstPart.trim();
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Type helpers for response envelopes
// ────────────────────────────────────────────────────────────────────────────

interface Envelope<T> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

// ────────────────────────────────────────────────────────────────────────────
// Main flow
// ────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Orchestration admin-API smoke test');
  console.log(`  Target: ${BASE_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── 0. Pre-flight: is the dev server up? ──────────────────────────────
  // Turbopack in dev lazy-compiles routes on first request, so this loop
  // also doubles as a warm-up for the two routes we hit in the next step.
  section(0, 'pre-flight checks');
  // 429 is accepted here — it still proves the server is alive and is
  // common when running the script twice in the same rate-limit window.
  await waitForRoute(`${BASE_URL}/api/v1/admin/orchestration/costs/summary`, [401, 403, 429]);
  await waitForRoute(`${BASE_URL}/api/auth/get-session`, [200, 401, 403, 429]);
  console.log(`    ✓ dev server reachable at ${BASE_URL}`);

  // Clean up any stale rows from a previous run (scoped by prefix).
  await preRunCleanup();
  console.log('    ✓ stale rows cleaned');

  // ── 1. Start mock OpenAI-compatible server ────────────────────────────
  section(1, 'start mock LLM server');
  const mock = await startMockServer();
  console.log(`    ✓ listening on ${mock.url}`);

  let adminCookie = '';
  let adminUserId = '';

  try {
    // ── 2. Sign up a throwaway admin ────────────────────────────────────
    section(2, 'sign up throwaway admin user');
    const signupRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        name: ADMIN_NAME,
      }),
    });
    if (!signupRes.ok) {
      throw new Error(`sign-up failed: ${signupRes.status} ${await signupRes.text()}`);
    }
    const setCookies = signupRes.headers.getSetCookie?.() ?? [];
    const sessionCookie = extractSessionCookie(setCookies);
    if (!sessionCookie) {
      throw new Error(`sign-up returned no session cookie (got ${setCookies.length} headers)`);
    }
    adminCookie = sessionCookie;
    console.log(`    ✓ signed up ${ADMIN_EMAIL}`);

    // Upgrade role to ADMIN — dev convenience so withAdminAuth lets us in.
    // Role is re-fetched from DB on every request by the auth guard.
    const user = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (!user) throw new Error('user row not found after signup');
    adminUserId = user.id;
    await prisma.user.update({
      where: { id: user.id },
      data: { role: 'ADMIN' },
    });
    console.log(`    ✓ upgraded ${ADMIN_EMAIL} to ADMIN role`);

    const api = buildClient(adminCookie);

    // ── 3. Seed provider config (isLocal → mock server) ────────────────
    // baseUrl ends in `/v1` so both the OpenAI SDK (chat) and the
    // knowledge embedder (which appends `/embeddings` directly) land on
    // the `/v1/*` paths our mock server exposes.
    section(3, 'POST /providers — seed mock-backed provider');
    const providerRes = await api<Envelope<{ id: string; slug: string }>>(
      'POST',
      '/api/v1/admin/orchestration/providers',
      {
        body: {
          name: 'Smoke Test Provider',
          slug: PROVIDER_SLUG,
          providerType: 'openai-compatible',
          baseUrl: `${mock.url}/v1`,
          isLocal: true,
          isActive: true,
        },
      }
    );
    checkRes('POST /providers returns 201', providerRes, 201);
    const providerId = providerRes.body?.data?.id ?? '';

    // GET /providers
    const listProvidersRes = await api('GET', '/api/v1/admin/orchestration/providers');
    checkRes('GET /providers returns 200', listProvidersRes, 200);

    // POST /providers/[id]/test — live connection to mock server
    const testProviderRes = await api<Envelope<{ ok: boolean; models: unknown[] }>>(
      'POST',
      `/api/v1/admin/orchestration/providers/${providerId}/test`
    );
    check(
      'provider test connection ok',
      testProviderRes.status === 200 && testProviderRes.body?.data?.ok === true,
      `status=${testProviderRes.status} body=${JSON.stringify(testProviderRes.body).slice(0, 200)}`
    );

    // ── 4. Agent CRUD + pivot ──────────────────────────────────────────
    section(4, 'agents CRUD');
    const createAgentRes = await api<Envelope<{ id: string; slug: string }>>(
      'POST',
      '/api/v1/admin/orchestration/agents',
      {
        body: {
          name: 'Smoke Test Agent',
          slug: AGENT_SLUG,
          description: 'Throwaway agent for orchestration smoke script',
          systemInstructions: 'You are a smoke test agent. Respond tersely.',
          model: 'smoke-mock-model',
          provider: PROVIDER_SLUG,
          temperature: 0.2,
          maxTokens: 512,
          monthlyBudgetUsd: 10,
          isActive: true,
        },
      }
    );
    checkRes('POST /agents returns 201', createAgentRes, 201);
    const agentId = createAgentRes.body?.data?.id ?? '';

    const getAgentRes = await api('GET', `/api/v1/admin/orchestration/agents/${agentId}`);
    checkRes('GET /agents/:id returns 200', getAgentRes, 200);

    const patchAgentRes = await api('PATCH', `/api/v1/admin/orchestration/agents/${agentId}`, {
      body: { description: 'Patched by smoke script' },
    });
    checkRes('PATCH /agents/:id returns 200', patchAgentRes, 200);

    // ── 4b. Widget config (item 7) — admin read/write + public roundtrip ─
    // Real-DB coverage for the JSONB column. Catches the things mocked
    // unit tests can't: column-name drift, Prisma type-gen mismatch,
    // CORS+auth on the public endpoint via X-Embed-Token.
    console.log('\n=== 4b. widget config + public /widget-config endpoint ===');

    const widgetGetDefaults = await api<
      Envelope<{ config: { primaryColor: string; headerTitle: string } }>
    >('GET', `/api/v1/admin/orchestration/agents/${agentId}/widget-config`);
    checkRes('GET /agents/:id/widget-config returns 200', widgetGetDefaults, 200);
    check(
      'GET /widget-config returns DEFAULT_WIDGET_CONFIG when stored value is null',
      widgetGetDefaults.body?.data?.config?.primaryColor === '#2563eb' &&
        widgetGetDefaults.body?.data?.config?.headerTitle === 'Chat'
    );

    const widgetPatchRes = await api<Envelope<{ config: { primaryColor: string } }>>(
      'PATCH',
      `/api/v1/admin/orchestration/agents/${agentId}/widget-config`,
      {
        body: {
          primaryColor: '#16a34a',
          headerTitle: 'Smoke council planning',
          conversationStarters: ['How do I apply?', 'What are the fees?'],
        },
      }
    );
    checkRes('PATCH /agents/:id/widget-config returns 200', widgetPatchRes, 200);
    check(
      'PATCH /widget-config returns merged config (custom + defaults)',
      widgetPatchRes.body?.data?.config?.primaryColor === '#16a34a'
    );

    // Verify it round-trips through Prisma JSONB by re-reading
    const widgetGetCustom = await api<
      Envelope<{
        config: { primaryColor: string; headerTitle: string; conversationStarters: string[] };
      }>
    >('GET', `/api/v1/admin/orchestration/agents/${agentId}/widget-config`);
    check(
      'Re-read /widget-config sees the persisted custom values',
      widgetGetCustom.body?.data?.config?.primaryColor === '#16a34a' &&
        widgetGetCustom.body?.data?.config?.headerTitle === 'Smoke council planning' &&
        widgetGetCustom.body?.data?.config?.conversationStarters?.length === 2
    );

    // Validation: bad hex must be rejected before reaching the DB
    const widgetBadHex = await api(
      'PATCH',
      `/api/v1/admin/orchestration/agents/${agentId}/widget-config`,
      { body: { primaryColor: 'not-a-colour' } }
    );
    checkRes('PATCH /widget-config rejects bad hex with 400', widgetBadHex, 400);

    // Public /widget-config — needs an embed token so we mint one first.
    const tokenCreateRes = await api<Envelope<{ token: string }>>(
      'POST',
      `/api/v1/admin/orchestration/agents/${agentId}/embed-tokens`,
      { body: { label: 'smoke', allowedOrigins: [] } }
    );
    checkRes('POST /agents/:id/embed-tokens returns 201', tokenCreateRes, 201);
    const embedToken = tokenCreateRes.body?.data?.token ?? '';

    const publicWidgetConfigRes = await fetch(`${BASE_URL}/api/v1/embed/widget-config`, {
      headers: { 'X-Embed-Token': embedToken },
    });
    const publicWidgetConfigBody = (await publicWidgetConfigRes.json()) as Envelope<{
      config: { primaryColor: string; headerTitle: string };
    }>;
    check(
      'GET /api/v1/embed/widget-config (X-Embed-Token) returns 200',
      publicWidgetConfigRes.status === 200
    );
    check(
      'Public /widget-config exposes the same persisted custom values',
      publicWidgetConfigBody.data?.config?.primaryColor === '#16a34a' &&
        publicWidgetConfigBody.data?.config?.headerTitle === 'Smoke council planning'
    );

    const publicWidgetNoTokenRes = await fetch(`${BASE_URL}/api/v1/embed/widget-config`);
    check('Public /widget-config without token returns 401', publicWidgetNoTokenRes.status === 401);

    // ── 5. Capability CRUD + attach ────────────────────────────────────
    section(5, 'capabilities CRUD + pivot attach');
    const createCapRes = await api<Envelope<{ id: string }>>(
      'POST',
      '/api/v1/admin/orchestration/capabilities',
      {
        body: {
          name: 'Smoke Echo Capability',
          slug: CAPABILITY_SLUG,
          description: 'Echoes input — purely for smoke testing',
          category: 'utility',
          functionDefinition: {
            name: 'smoke_echo',
            description: 'Echo back the provided text.',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
          executionType: 'internal',
          executionHandler: 'smoke.echo',
          requiresApproval: false,
          isActive: true,
        },
      }
    );
    checkRes('POST /capabilities returns 201', createCapRes, 201);
    const capabilityId = createCapRes.body?.data?.id ?? '';

    const attachRes = await api(
      'POST',
      `/api/v1/admin/orchestration/agents/${agentId}/capabilities`,
      { body: { capabilityId, isEnabled: true } }
    );
    checkRes('POST /agents/:id/capabilities returns 201', attachRes, 201);
    // Note: there is no GET /agents/:id/capabilities route — pivot is verified
    // via the 201 attach response above and via agent fetch includes if needed.

    // ── 6. Workflows CRUD + validate + execute stub ────────────────────
    // Workflow step shape per workflowDefinitionSchema:
    //   { id, name, type, config, nextSteps: [{targetStepId, condition?}] }
    section(6, 'workflows CRUD + validate + execute stub');
    const createWorkflowRes = await api<Envelope<{ id: string }>>(
      'POST',
      '/api/v1/admin/orchestration/workflows',
      {
        body: {
          name: 'Smoke Test Workflow',
          slug: WORKFLOW_SLUG,
          description: 'Minimal DAG for smoke testing the validator + stub execute route',
          workflowDefinition: {
            steps: [
              {
                id: 'start',
                name: 'Start',
                type: 'tool_call',
                config: { capabilitySlug: CAPABILITY_SLUG },
                nextSteps: [{ targetStepId: 'end' }],
              },
              {
                id: 'end',
                name: 'End',
                type: 'tool_call',
                config: { capabilitySlug: CAPABILITY_SLUG },
                nextSteps: [],
              },
            ],
            entryStepId: 'start',
            errorStrategy: 'fail',
          },
          patternsUsed: [],
        },
      }
    );
    checkRes('POST /workflows returns 201', createWorkflowRes, 201);
    const workflowId = createWorkflowRes.body?.data?.id ?? '';

    const validateRes = await api<Envelope<{ ok: boolean; errors: unknown[] }>>(
      'POST',
      `/api/v1/admin/orchestration/workflows/${workflowId}/validate`
    );
    check(
      'POST /workflows/:id/validate returns ok:true',
      validateRes.status === 200 && validateRes.body?.data?.ok === true,
      `status=${validateRes.status} body=${JSON.stringify(validateRes.body).slice(0, 200)}`
    );

    const executeStubRes = await api(
      'POST',
      `/api/v1/admin/orchestration/workflows/${workflowId}/execute`,
      { body: { workflowId, inputData: {} } }
    );
    checkRes('POST /workflows/:id/execute returns 501 stub', executeStubRes, 501);

    // ── 7. Streaming chat ──────────────────────────────────────────────
    section(7, 'POST /chat/stream — SSE via ReadableStream');
    const streamRes = await fetch(`${BASE_URL}/api/v1/admin/orchestration/chat/stream`, {
      method: 'POST',
      headers: {
        cookie: adminCookie,
        origin: BASE_URL,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ agentSlug: AGENT_SLUG, message: 'smoke test, please reply' }),
    });
    check('chat stream returns 200', streamRes.status === 200);
    check(
      'chat stream content-type is text/event-stream',
      (streamRes.headers.get('content-type') ?? '').includes('text/event-stream')
    );
    const streamText = await streamRes.text();
    const eventTypes = Array.from(streamText.matchAll(/event:\s*(\w+)/g)).map((m) => m[1]);
    check(
      'chat stream emits start event',
      eventTypes.includes('start'),
      `events=${eventTypes.join(',') || '(none)'}`
    );
    check(
      'chat stream terminates with done (or error) event',
      eventTypes.includes('done') || eventTypes.includes('error'),
      `events=${eventTypes.join(',') || '(none)'}`
    );

    // ── 8. Knowledge: upload mock markdown + search ────────────────────
    section(8, 'knowledge upload + search');
    const form = new FormData();
    form.append('file', new Blob([MOCK_MARKDOWN], { type: 'text/markdown' }), 'smoke-test.md');
    const uploadRes = await api<Envelope<{ document: { id: string; status: string } }>>(
      'POST',
      '/api/v1/admin/orchestration/knowledge/documents',
      { body: form }
    );
    checkRes('POST /knowledge/documents returns 201', uploadRes, 201);
    const documentId = uploadRes.body?.data?.document?.id ?? '';
    check(
      'document finished processing (status=ready)',
      uploadRes.body?.data?.document?.status === 'ready',
      `status=${uploadRes.body?.data?.document?.status}`
    );
    check('mock server received embedding calls', mock.embedCalls > 0);

    // Knowledge search is POST (not GET) — filter payloads contain arbitrary
    // text that shouldn't end up in access logs.
    const searchRes = await api<Envelope<{ results: unknown[] }>>(
      'POST',
      '/api/v1/admin/orchestration/knowledge/search',
      { body: { query: 'reflection pattern', limit: 5 } }
    );
    check(
      'POST /knowledge/search returns 200',
      searchRes.status === 200 && Array.isArray(searchRes.body?.data?.results),
      `status=${searchRes.status} body=${JSON.stringify(searchRes.body).slice(0, 200)}`
    );

    // ── 9. Evaluations: create + complete (uses mock LLM) ──────────────
    section(9, 'evaluations CRUD + complete');
    // POST /evaluations returns the session row directly in `data` (no wrapper).
    const createEvalRes = await api<Envelope<{ id: string }>>(
      'POST',
      '/api/v1/admin/orchestration/evaluations',
      {
        body: {
          agentId,
          title: 'Smoke Evaluation',
          description: 'Throwaway eval for the smoke script',
        },
      }
    );
    checkRes('POST /evaluations returns 201', createEvalRes, 201);
    const evaluationId = createEvalRes.body?.data?.id ?? '';

    // Seed at least one log row directly via prisma — the Phase 3.4
    // evaluation API has no log-write endpoint yet (that's Phase 4).
    await prisma.aiEvaluationLog.create({
      data: {
        sessionId: evaluationId,
        sequenceNumber: 1,
        eventType: 'user_input',
        content: 'What is the reflection pattern?',
      },
    });
    await prisma.aiEvaluationLog.create({
      data: {
        sessionId: evaluationId,
        sequenceNumber: 2,
        eventType: 'ai_response',
        content: 'Reflection asks the agent to critique its own output.',
      },
    });

    const completeRes = await api<Envelope<{ session: { status: string; summary: string } }>>(
      'POST',
      `/api/v1/admin/orchestration/evaluations/${evaluationId}/complete`,
      {
        body: {},
      }
    );
    check(
      'complete evaluation returns 200',
      completeRes.status === 200,
      `status=${completeRes.status} body=${JSON.stringify(completeRes.body).slice(0, 200)}`
    );
    check(
      'completed evaluation has non-empty summary',
      (completeRes.body?.data?.session?.summary?.length ?? 0) > 0
    );

    // ── 10. Conversations list + clear (ownership-scoped) ──────────────
    section(10, 'conversations list + clear');
    const listConvsRes = await api<Envelope<{ conversations: unknown[] }>>(
      'GET',
      '/api/v1/admin/orchestration/conversations'
    );
    check('GET /conversations returns 200', listConvsRes.status === 200);

    const clearEmptyRes = await api('POST', '/api/v1/admin/orchestration/conversations/clear', {
      body: {},
    });
    check(
      'POST /conversations/clear without filter rejects (400)',
      clearEmptyRes.status === 400,
      `got ${clearEmptyRes.status}`
    );

    const clearScopedRes = await api<Envelope<{ deleted: number }>>(
      'POST',
      '/api/v1/admin/orchestration/conversations/clear',
      { body: { agentId } }
    );
    check('POST /conversations/clear with agentId returns 200', clearScopedRes.status === 200);

    // ── 11. Costs observability ────────────────────────────────────────
    section(11, 'costs observability');
    const summaryRes = await api<
      Envelope<{ totals: { today: number; week: number; month: number } }>
    >('GET', '/api/v1/admin/orchestration/costs/summary');
    check('GET /costs/summary returns 200', summaryRes.status === 200);

    const dateFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const dateTo = new Date().toISOString();
    const breakdownRes = await api(
      'GET',
      `/api/v1/admin/orchestration/costs?dateFrom=${dateFrom}&dateTo=${dateTo}&groupBy=agent`
    );
    check('GET /costs (breakdown) returns 200', breakdownRes.status === 200);

    const alertsRes = await api('GET', '/api/v1/admin/orchestration/costs/alerts');
    check('GET /costs/alerts returns 200', alertsRes.status === 200);

    const budgetRes = await api<
      Envelope<{ withinBudget: boolean; monthlyBudgetUsd: number | null }>
    >('GET', `/api/v1/admin/orchestration/agents/${agentId}/budget`);
    check('GET /agents/:id/budget returns 200', budgetRes.status === 200);

    // ── 12. Verify cost logging landed in Postgres ─────────────────────
    section(12, 'verify cost logs persisted');
    // Give fire-and-forget logCost writes a tick to settle.
    await new Promise((r) => setTimeout(r, 500));
    const costLogs = await prisma.aiCostLog.findMany({
      where: { agentId },
      orderBy: { createdAt: 'asc' },
    });
    check(`at least one AiCostLog row persisted (found ${costLogs.length})`, costLogs.length > 0);
    if (costLogs.length > 0) {
      for (const c of costLogs) {
        console.log(
          `      • ${c.operation} in=${c.inputTokens} out=${c.outputTokens} cost=$${c.totalCostUsd}`
        );
      }
    }

    // ── 13. Mock server stats ──────────────────────────────────────────
    section(13, 'mock LLM server stats');
    console.log(`    chat.completions calls: ${mock.chatCalls}`);
    console.log(`    embeddings calls:       ${mock.embedCalls}`);
    check('mock server received at least one chat call', mock.chatCalls > 0);
    check('mock server received at least one embed call', mock.embedCalls > 0);

    // ── 14. Cleanup ────────────────────────────────────────────────────
    section(14, 'cleanup (scoped)');
    // Delete in FK-safe order. All scoped by agent / slug prefix.
    await cleanupScoped(agentId, capabilityId, providerId, workflowId, documentId, adminUserId);
    console.log('    ✓ scoped rows deleted');
  } catch (err) {
    console.error('\n✗ smoke script error:', err);
    failed++;
    // Best-effort cleanup even on error — use prefix scans.
    try {
      await preRunCleanup();
      if (adminUserId) {
        await prisma.user.delete({ where: { id: adminUserId } }).catch(() => undefined);
      }
    } catch {
      /* ignore */
    }
  } finally {
    await mock.close();
    await prisma.$disconnect();
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  process.exit(failed > 0 ? 1 : 0);
}

// ────────────────────────────────────────────────────────────────────────────
// Cleanup helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Delete any stale rows from a previous smoke run. Scoped strictly by the
 * `smoke-test-orch-*` prefix — never touches other data.
 */
async function preRunCleanup(): Promise<void> {
  const agents = await prisma.aiAgent.findMany({
    where: { slug: { startsWith: SMOKE_PREFIX } },
    select: { id: true },
  });
  const agentIds = agents.map((a) => a.id);

  if (agentIds.length > 0) {
    const convs = await prisma.aiConversation.findMany({
      where: { agentId: { in: agentIds } },
      select: { id: true },
    });
    const convIds = convs.map((c) => c.id);
    if (convIds.length > 0) {
      await prisma.aiMessage.deleteMany({ where: { conversationId: { in: convIds } } });
      await prisma.aiConversation.deleteMany({ where: { id: { in: convIds } } });
    }

    const evals = await prisma.aiEvaluationSession.findMany({
      where: { agentId: { in: agentIds } },
      select: { id: true },
    });
    const evalIds = evals.map((e) => e.id);
    if (evalIds.length > 0) {
      await prisma.aiEvaluationLog.deleteMany({ where: { sessionId: { in: evalIds } } });
      await prisma.aiEvaluationSession.deleteMany({ where: { id: { in: evalIds } } });
    }

    await prisma.aiCostLog.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.aiAgentCapability.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.aiAgent.deleteMany({ where: { id: { in: agentIds } } });
  }

  await prisma.aiCapability.deleteMany({ where: { slug: { startsWith: SMOKE_PREFIX } } });
  await prisma.aiWorkflow.deleteMany({ where: { slug: { startsWith: SMOKE_PREFIX } } });
  await prisma.aiProviderConfig.deleteMany({ where: { slug: { startsWith: SMOKE_PREFIX } } });

  // Knowledge documents uploaded by the smoke test (name starts with 'smoke-test').
  const docs = await prisma.aiKnowledgeDocument.findMany({
    where: { fileName: { startsWith: 'smoke-test' } },
    select: { id: true },
  });
  const docIds = docs.map((d) => d.id);
  if (docIds.length > 0) {
    await prisma.aiKnowledgeChunk.deleteMany({ where: { documentId: { in: docIds } } });
    await prisma.aiKnowledgeDocument.deleteMany({ where: { id: { in: docIds } } });
  }

  // Users are cleaned up individually at the end of the current run (id is
  // known). Stale users from past runs are left alone — they can't affect
  // the current run because each run mints a fresh timestamped email.
}

async function cleanupScoped(
  agentId: string,
  capabilityId: string,
  providerId: string,
  workflowId: string,
  documentId: string,
  userId: string
): Promise<void> {
  if (documentId) {
    await prisma.aiKnowledgeChunk.deleteMany({ where: { documentId } }).catch(() => undefined);
    await prisma.aiKnowledgeDocument
      .deleteMany({ where: { id: documentId } })
      .catch(() => undefined);
  }
  if (agentId) {
    const convs = await prisma.aiConversation.findMany({
      where: { agentId },
      select: { id: true },
    });
    const convIds = convs.map((c) => c.id);
    if (convIds.length > 0) {
      await prisma.aiMessage.deleteMany({ where: { conversationId: { in: convIds } } });
      await prisma.aiConversation.deleteMany({ where: { id: { in: convIds } } });
    }
    const evals = await prisma.aiEvaluationSession.findMany({
      where: { agentId },
      select: { id: true },
    });
    const evalIds = evals.map((e) => e.id);
    if (evalIds.length > 0) {
      await prisma.aiEvaluationLog.deleteMany({ where: { sessionId: { in: evalIds } } });
      await prisma.aiEvaluationSession.deleteMany({ where: { id: { in: evalIds } } });
    }
    await prisma.aiCostLog.deleteMany({ where: { agentId } });
    await prisma.aiAgentCapability.deleteMany({ where: { agentId } });
    await prisma.aiAgent.deleteMany({ where: { id: agentId } });
  }
  if (capabilityId) {
    await prisma.aiCapability.deleteMany({ where: { id: capabilityId } });
  }
  if (workflowId) {
    await prisma.aiWorkflow.deleteMany({ where: { id: workflowId } });
  }
  if (providerId) {
    await prisma.aiProviderConfig.deleteMany({ where: { id: providerId } });
  }
  if (userId) {
    // Delete auth-related rows first (sessions, accounts, verifications).
    await prisma.session.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.account.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => undefined);
  }
}

main().catch(async (err) => {
  console.error('\n✗ unhandled error:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
