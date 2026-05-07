/**
 * Integration Test: Inbound Trigger Route — end-to-end through real adapters
 *
 * POST /api/v1/inbound/:channel/:slug
 *
 * Tests the inbound trigger route with real adapters (SlackAdapter,
 * GenericHmacAdapter, PostmarkAdapter) registered against test credentials.
 * Prisma is mocked; drainEngine is stubbed. The test scope covers:
 *   adapter verify → trigger lookup → execution insert → 202
 *
 * Channels tested: slack, hmac, postmark
 * Paths covered: happy-path, dedup, event filter, bad-signature, observability
 *
 * Adapter bootstrap: env vars are stubbed in beforeAll, then
 *   resetInboundAdapters() + resetBootstrapState() + bootstrapInboundAdapters()
 * are called to register the real adapters against the test secrets.
 *
 * Rate limiter: each request uses a unique x-forwarded-for IP to avoid
 * collisions across tests (the LRU is module-level).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { parseJSON } from '@/tests/helpers/assertions';

// ─── Mocks — declared before module imports ───────────────────────────────────

// Stub drainEngine only — preserves all other scheduler exports.
vi.mock('@/lib/orchestration/scheduling/scheduler', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/orchestration/scheduling/scheduler')>();
  return { ...mod, drainEngine: vi.fn(async () => {}) };
});

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  inboundLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

// Mock audit logger — we assert via mock spy (real would need a DB).
vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

// Real prisma is not available in this test suite (no testcontainer); mock it
// so we control trigger lookup and execution insert responses.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowTrigger: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    aiWorkflowExecution: {
      create: vi.fn(),
    },
    aiAdminAuditLog: {
      create: vi.fn(),
    },
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/inbound/[channel]/[slug]/route';
import { prisma } from '@/lib/db/client';
import { inboundLimiter } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { drainEngine } from '@/lib/orchestration/scheduling/scheduler';
import { resetInboundAdapters, getInboundAdapter } from '@/lib/orchestration/inbound/registry';
import {
  bootstrapInboundAdapters,
  resetBootstrapState,
} from '@/lib/orchestration/inbound/bootstrap';
import { signHookPayload } from '@/lib/orchestration/hooks/signing';

// ─── Test constants ───────────────────────────────────────────────────────────

const SLACK_TEST_SECRET = 'test-slack-secret';
const POSTMARK_TEST_USER = 'inbound-user';
const POSTMARK_TEST_PASS = 'inbound-pass';
const HMAC_TEST_SECRET = 'hmac-per-trigger-secret';

const WORKFLOW_ID = 'wf_integration_01';
const VERSION_ID = 'wv_integration_01';
const TRIGGER_ID_SLACK = 'trig_slack_01';
const TRIGGER_ID_HMAC = 'trig_hmac_01';
const TRIGGER_ID_POSTMARK = 'trig_postmark_01';
const USER_ID = 'user_integration_01';
const EXECUTION_ID = 'exec_integration_01';

const WORKFLOW_SLUG = 'integration-test-workflow';

/**
 * Minimal valid workflow definition that passes workflowDefinitionSchema.
 * workflowDefinitionSchema requires steps[].name and steps[].nextSteps (via schema defaults).
 */
const VALID_SNAPSHOT = {
  steps: [
    {
      id: 'step-1',
      name: 'Start',
      type: 'llm_call',
      config: {},
      nextSteps: [],
    },
  ],
  entryStepId: 'step-1',
  errorStrategy: 'fail' as const,
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeTriggerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TRIGGER_ID_SLACK,
    workflowId: WORKFLOW_ID,
    channel: 'slack',
    name: 'Integration Slack Trigger',
    metadata: {},
    signingSecret: null,
    isEnabled: true,
    lastFiredAt: null,
    createdBy: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    workflow: {
      id: WORKFLOW_ID,
      slug: WORKFLOW_SLUG,
      publishedVersion: {
        id: VERSION_ID,
        snapshot: VALID_SNAPSHOT,
      },
    },
    ...overrides,
  };
}

function makeExecutionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EXECUTION_ID,
    workflowId: WORKFLOW_ID,
    versionId: VERSION_ID,
    status: 'pending',
    inputData: {},
    executionTrace: [],
    userId: USER_ID,
    triggerSource: 'inbound:slack',
    triggerExternalId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Request builders ─────────────────────────────────────────────────────────

/** Build a valid Slack-signed POST request. */
function makeSlackRequest(
  channel: string,
  slug: string,
  body: Record<string, unknown>,
  {
    secret = SLACK_TEST_SECRET,
    ip = '10.0.0.1',
    tamperBody = false,
    staleSec = 0,
  }: {
    secret?: string;
    ip?: string;
    tamperBody?: boolean;
    staleSec?: number;
  } = {}
): NextRequest {
  const rawBody = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000) - staleSec;
  const sigBody = tamperBody ? rawBody + 'TAMPERED' : rawBody;
  const sigBase = `v0:${ts}:${sigBody}`;
  const hex = createHmac('sha256', secret).update(sigBase).digest('hex');

  return new NextRequest(`http://localhost:3000/api/v1/inbound/${channel}/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-slack-signature': `v0=${hex}`,
      'x-slack-request-timestamp': String(ts),
      'x-forwarded-for': ip,
    },
    body: rawBody,
  });
}

/**
 * Build a valid HMAC-signed POST request for the generic-hmac channel.
 *
 * `eventId`, when provided, is added to the BODY (not a header) and therefore
 * covered by the HMAC signature. This blocks the replay-via-header-mutation
 * vector that an unsigned `X-Sunrise-Event-Id` would expose.
 */
function makeHmacRequest(
  channel: string,
  slug: string,
  body: Record<string, unknown>,
  {
    secret = HMAC_TEST_SECRET,
    ip = '10.0.1.1',
    eventId,
  }: { secret?: string; ip?: string; eventId?: string } = {}
): NextRequest {
  const signedBody = eventId ? { ...body, eventId } : body;
  const rawBody = JSON.stringify(signedBody);
  const ts = Math.floor(Date.now() / 1000);
  const { timestamp, signature } = signHookPayload(secret, rawBody, ts);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-sunrise-signature': signature,
    'x-sunrise-timestamp': timestamp,
    'x-forwarded-for': ip,
  };

  return new NextRequest(`http://localhost:3000/api/v1/inbound/${channel}/${slug}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

/** Build a Postmark Basic-auth authenticated POST request. */
function makePostmarkRequest(
  channel: string,
  slug: string,
  body: Record<string, unknown>,
  {
    user = POSTMARK_TEST_USER,
    pass = POSTMARK_TEST_PASS,
    ip = '10.0.2.1',
  }: { user?: string; pass?: string; ip?: string } = {}
): NextRequest {
  const credentials = Buffer.from(`${user}:${pass}`).toString('base64');

  return new NextRequest(`http://localhost:3000/api/v1/inbound/${channel}/${slug}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${credentials}`,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  });
}

function makeParams(channel: string, slug: string) {
  return { params: Promise.resolve({ channel, slug }) };
}

// ─── Interface for typed response parsing ────────────────────────────────────

interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

interface ErrorEnvelope {
  success: false;
  error: { code: string; message: string };
}

type ApiResponse<T> = SuccessEnvelope<T> | ErrorEnvelope;

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeAll(() => {
  // Stub env vars — real adapters read these at bootstrap.
  vi.stubEnv('SLACK_SIGNING_SECRET', SLACK_TEST_SECRET);
  vi.stubEnv('POSTMARK_INBOUND_USER', POSTMARK_TEST_USER);
  vi.stubEnv('POSTMARK_INBOUND_PASS', POSTMARK_TEST_PASS);

  // Reset any prior adapter state, then bootstrap fresh against the test secrets.
  resetInboundAdapters();
  resetBootstrapState();
  bootstrapInboundAdapters();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetInboundAdapters();
  resetBootstrapState();
});

beforeEach(() => {
  vi.clearAllMocks();

  // Restore rate limiter to pass by default (tests that need 429 override locally).
  vi.mocked(inboundLimiter.check).mockReturnValue({ success: true } as never);

  // Default: trigger lookup returns null (tests override per scenario).
  vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(null);

  // Default: execution insert returns a new row.
  vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue(makeExecutionRow() as never);

  // Default: lastFiredAt update resolves silently.
  vi.mocked(prisma.aiWorkflowTrigger.update).mockResolvedValue({} as never);

  // Default: getClientIP returns a unique IP (each test should override if needed).
  vi.mocked(getClientIP).mockReturnValue('127.0.0.1');
});

// ─── Verify bootstrap ─────────────────────────────────────────────────────────

describe('bootstrap sanity', () => {
  it('slack adapter is registered after bootstrap', () => {
    const adapter = getInboundAdapter('slack');
    expect(adapter).not.toBeNull();
    expect(adapter?.channel).toBe('slack');
  });

  it('hmac adapter is registered after bootstrap', () => {
    const adapter = getInboundAdapter('hmac');
    expect(adapter).not.toBeNull();
    expect(adapter?.channel).toBe('hmac');
  });

  it('postmark adapter is registered after bootstrap', () => {
    const adapter = getInboundAdapter('postmark');
    expect(adapter).not.toBeNull();
    expect(adapter?.channel).toBe('postmark');
  });
});

// ─── Rate limit ───────────────────────────────────────────────────────────────

describe('rate limit', () => {
  it('returns 429 and the rate-limit error envelope when inboundLimiter.check returns success:false', async () => {
    // Arrange — override rate limiter for this test only.
    vi.mocked(inboundLimiter.check).mockReturnValue({
      success: false,
      limit: 60,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
    } as never);

    const body = { type: 'event_callback', event: { type: 'message' } };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.9.0.1' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert — status first, then error envelope shape.
    expect(response.status).toBe(429);
    const respBody = await parseJSON<ErrorEnvelope>(response);
    expect(respBody.success).toBe(false);
    expect(respBody.error.code).toBe('RATE_LIMITED');

    // Rate-limited path must not reach trigger lookup.
    expect(prisma.aiWorkflowTrigger.findFirst).not.toHaveBeenCalled();
  });
});

// ─── Slack channel ────────────────────────────────────────────────────────────

describe('Slack channel', () => {
  describe('URL-verification handshake', () => {
    it('returns 200 plain-text challenge before trigger lookup on url_verification', async () => {
      // Arrange — Slack sends url_verification probe before any trigger is configured.
      // Trigger row deliberately absent (findFirst stays null from beforeEach).
      const body = { type: 'url_verification', challenge: 'abc123' };
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.0.0.10' });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first, then body
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe('abc123');

      // Handshake runs before trigger lookup — prisma should NOT have been queried.
      expect(prisma.aiWorkflowTrigger.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('happy path — event_callback', () => {
    const EVENT_ID = 'Ev123ABC';
    const slackEventBody = {
      type: 'event_callback',
      event_id: EVENT_ID,
      team_id: 'T12345',
      api_app_id: 'A12345',
      event_time: 1700000000,
      event: {
        type: 'app_mention',
        user: 'U12345',
        text: 'Hello bot',
        ts: '1700000000.000001',
        channel: 'C12345',
      },
    };

    it('returns 202 with executionId on valid Slack signature', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue(
        makeExecutionRow({ id: EXECUTION_ID, triggerSource: 'inbound:slack' }) as never
      );
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, slackEventBody, {
        ip: '10.0.0.20',
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);
      const body = await parseJSON<
        ApiResponse<{
          executionId: string;
          channel: string;
          workflowSlug: string;
          status: string;
        }>
      >(response);
      expect(body.success).toBe(true);
      // test-review:accept tobe_true — structural boolean on API envelope
      if (body.success) {
        expect(body.data.executionId).toBe(EXECUTION_ID);
        expect(body.data.channel).toBe('slack');
        expect(body.data.workflowSlug).toBe(WORKFLOW_SLUG);
        expect(body.data.status).toBe('pending');
      }
    });

    it('calls prisma.aiWorkflowExecution.create with triggerSource inbound:slack and channel-global dedupKey', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, slackEventBody, {
        ip: '10.0.0.21',
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — the create call must carry the correct attribution fields and
      // the channel-global dedupKey (`slack:<event_id>`). See security review Vuln 2.
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            triggerSource: 'inbound:slack',
            versionId: VERSION_ID,
            userId: USER_ID,
            status: 'pending',
            dedupKey: `slack:${slackEventBody.event_id}`,
          }),
        })
      );
    });

    it('carries normalised Slack event payload in inputData.trigger and triggerMeta envelope', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, slackEventBody, {
        ip: '10.0.0.22',
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — inputData must contain the normalised Slack payload in .trigger
      // and the channel metadata envelope in .triggerMeta (built by route.ts:230-236).
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inputData: expect.objectContaining({
              trigger: expect.objectContaining({
                teamId: 'T12345',
                type: 'app_mention',
                user: 'U12345',
                text: 'Hello bot',
              }),
              triggerMeta: expect.objectContaining({
                channel: 'slack',
                eventType: 'app_mention',
                externalId: expect.any(String),
              }),
            }),
          }),
        })
      );
    });

    it('fires drainEngine after successful execution insert', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, slackEventBody, {
        ip: '10.0.0.23',
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — drainEngine was called fire-and-forget with the executionId.
      expect(drainEngine).toHaveBeenCalledWith(
        EXECUTION_ID,
        expect.objectContaining({ id: WORKFLOW_ID, slug: WORKFLOW_SLUG }),
        expect.objectContaining({ steps: expect.any(Array), entryStepId: 'step-1' }),
        expect.any(Object),
        USER_ID,
        VERSION_ID
      );
    });

    it('writes an audit log entry with workflow_trigger.fire action', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, slackEventBody, {
        ip: '10.0.0.24',
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — logAdminAction must be called with the canonical audit action.
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_trigger.fire',
          entityType: 'workflow_trigger',
          entityId: TRIGGER_ID_SLACK,
          userId: USER_ID,
          metadata: expect.objectContaining({
            channel: 'slack',
            executionId: EXECUTION_ID,
          }),
        })
      );
    });

    it('updates trigger lastFiredAt after successful fire', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, slackEventBody, {
        ip: '10.0.0.25',
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Wait briefly for the void best-effort update to settle.
      await vi.waitFor(() => {
        expect(prisma.aiWorkflowTrigger.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: TRIGGER_ID_SLACK },
            data: expect.objectContaining({ lastFiredAt: expect.any(Date) }),
          })
        );
      });
    });
  });

  describe('deduplication', () => {
    it('returns 200 with deduped:true when execution row already exists (P2002)', async () => {
      // Arrange — simulate Slack re-sending an event we already processed.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );

      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed on the fields: (`dedupKey`)',
        { code: 'P2002', clientVersion: '7.0.0', meta: { target: ['dedupKey'] } }
      );
      vi.mocked(prisma.aiWorkflowExecution.create).mockRejectedValue(p2002);

      const body = {
        type: 'event_callback',
        event_id: 'Ev_DEDUP_001',
        team_id: 'T12345',
        event: { type: 'message', user: 'U12345', text: 'duplicate' },
      };
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.0.0.30' });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(200);
      const respBody = await parseJSON<ApiResponse<{ deduped: boolean }>>(response);
      expect(respBody.success).toBe(true);
      if (respBody.success) {
        expect(respBody.data.deduped).toBe(true);
      }

      // The deduplicated path must NOT create a second execution row.
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledTimes(1);
    });

    it('uses channel-global dedupKey for slack so cross-workflow replays collide (security review Vuln 2)', async () => {
      // Arrange — Slack signs only `v0:{ts}:{body}`; the destination URL is NOT
      // part of the signed envelope. An attacker who captures one valid Slack
      // delivery (e.g. via APM/log access) could replay it within the 5-min
      // window to a DIFFERENT workflow's URL on the same instance, since they
      // both share one workspace SLACK_SIGNING_SECRET. Channel-global dedupKey
      // (`slack:<event_id>`) makes the second workflow's insert collide on the
      // SAME dedupKey as the first, blocking the cross-workflow replay vector.
      const eventId = 'Ev_CROSS_WORKFLOW_REPLAY';
      const body = {
        type: 'event_callback',
        event_id: eventId,
        team_id: 'T12345',
        event: { type: 'message', user: 'U12345', text: 'captured by attacker' },
      };

      // First leg: legitimate event lands on the originally targeted workflow.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValueOnce(
        makeTriggerRow({
          id: TRIGGER_ID_SLACK,
          channel: 'slack',
          workflowId: 'wf-A',
        }) as never
      );

      const requestA = makeSlackRequest('slack', 'workflow-a', body, { ip: '10.0.0.50' });
      const responseA = await POST(requestA, makeParams('slack', 'workflow-a'));
      expect(responseA.status).toBe(202);

      // Capture the dedupKey from the first create — it's channel-global, NOT
      // per-workflow, so the same key would block subsequent inserts regardless
      // of which workflow they target.
      const firstCreateArgs = vi.mocked(prisma.aiWorkflowExecution.create).mock.calls[0]?.[0];
      const firstDedupKey = (firstCreateArgs?.data as { dedupKey?: string | null })?.dedupKey;
      expect(firstDedupKey).toBe(`slack:${eventId}`);

      // Second leg: attacker replays the same body+sig+ts to a DIFFERENT
      // workflow's URL. The trigger lookup returns workflow B's row.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValueOnce(
        makeTriggerRow({
          id: 'trigger-id-slack-B',
          channel: 'slack',
          workflowId: 'wf-B',
        }) as never
      );

      const requestB = makeSlackRequest('slack', 'workflow-b', body, { ip: '10.0.0.50' });
      // The mocked Prisma client doesn't enforce uniqueness, so we observe the
      // create call directly: it must carry the SAME dedupKey, proving the
      // database unique would collide on a real Postgres instance.
      await POST(requestB, makeParams('slack', 'workflow-b'));

      const secondCreateArgs = vi.mocked(prisma.aiWorkflowExecution.create).mock.calls[1]?.[0];
      const secondDedupKey = (secondCreateArgs?.data as { dedupKey?: string | null })?.dedupKey;

      // Channel-global scope means the same dedupKey for the same Slack event_id,
      // regardless of which workflow it's targeted at. The database's UNIQUE
      // constraint on dedupKey then blocks the replay at insert time.
      expect(secondDedupKey).toBe(`slack:${eventId}`);
      expect(secondDedupKey).toBe(firstDedupKey);
    });
  });

  describe('authentication failures', () => {
    it('returns 401 on tampered body (bad Slack signature)', async () => {
      // Arrange — trigger exists but the signature is for the wrong body.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const body = {
        type: 'event_callback',
        event_id: 'Ev_BAD_SIG',
        event: { type: 'message' },
      };
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, {
        ip: '10.0.0.40',
        tamperBody: true,
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(401);
      const respBody = await parseJSON<ErrorEnvelope>(response);
      expect(respBody.success).toBe(false);
      expect(respBody.error.code).toBe('UNAUTHORIZED');

      // No execution row must be created on auth failure.
      expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
    });

    it('returns 401 on stale Slack timestamp (10 minutes old)', async () => {
      // Arrange — trigger exists, but the request timestamp is 600s old.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const body = {
        type: 'event_callback',
        event_id: 'Ev_STALE',
        event: { type: 'message' },
      };
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, {
        ip: '10.0.0.41',
        staleSec: 600, // 10 minutes ago
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert
      expect(response.status).toBe(401);
      const respBody = await parseJSON<ErrorEnvelope>(response);
      expect(respBody.success).toBe(false);
      expect(respBody.error.code).toBe('UNAUTHORIZED');

      // No execution row on auth failure.
      expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
    });

    it('does NOT write an audit log on failed verification', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
      );
      const body = { type: 'event_callback', event_id: 'Ev_BAD', event: { type: 'message' } };
      const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, {
        ip: '10.0.0.42',
        tamperBody: true,
      });

      // Act
      const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(401);

      // Assert — logAdminAction must NOT be called for failed auth attempts.
      expect(logAdminAction).not.toHaveBeenCalled();
    });
  });
});

// ─── Generic-HMAC channel ─────────────────────────────────────────────────────

describe('HMAC channel', () => {
  describe('happy path', () => {
    it('returns 202 with execution row for valid HMAC signature and externalId from header', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_HMAC,
          channel: 'hmac',
          signingSecret: HMAC_TEST_SECRET,
        }) as never
      );
      vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue(
        makeExecutionRow({
          id: EXECUTION_ID,
          triggerSource: 'inbound:hmac',
          triggerExternalId: 'hmac-event-001',
        }) as never
      );

      const body = { action: 'data_updated', payload: { recordId: '42' } };
      const request = makeHmacRequest('hmac', WORKFLOW_SLUG, body, {
        ip: '10.1.0.10',
        eventId: 'hmac-event-001',
      });

      // Act
      const response = await POST(request, makeParams('hmac', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);
      const respBody =
        await parseJSON<ApiResponse<{ executionId: string; channel: string }>>(response);
      expect(respBody.success).toBe(true);
      if (respBody.success) {
        expect(respBody.data.executionId).toBe(EXECUTION_ID);
        expect(respBody.data.channel).toBe('hmac');
      }
    });

    it('calls prisma.aiWorkflowExecution.create with triggerSource inbound:hmac', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_HMAC,
          channel: 'hmac',
          signingSecret: HMAC_TEST_SECRET,
        }) as never
      );

      const body = { action: 'ping' };
      const request = makeHmacRequest('hmac', WORKFLOW_SLUG, body, { ip: '10.1.0.11' });

      // Act
      const response = await POST(request, makeParams('hmac', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — the create call must carry correct attribution.
      // No body.eventId on this request → externalId is null and dedupKey is null.
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            triggerSource: 'inbound:hmac',
            versionId: VERSION_ID,
            userId: USER_ID,
            triggerExternalId: null,
            dedupKey: null,
            inputData: expect.objectContaining({
              triggerMeta: expect.objectContaining({
                channel: 'hmac',
                externalId: null,
              }),
            }),
          }),
        })
      );
    });

    it('carries triggerExternalId, triggerMeta.externalId, and dedupKey when body.eventId is signed in', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_HMAC,
          channel: 'hmac',
          signingSecret: HMAC_TEST_SECRET,
        }) as never
      );

      const body = { action: 'event_with_id' };
      const eventId = 'hmac-evt-ext-001';
      // makeHmacRequest puts eventId INSIDE the body (covered by HMAC) — never as a header.
      // Mutating the eventId post-signing would invalidate the signature.
      const request = makeHmacRequest('hmac', WORKFLOW_SLUG, body, {
        ip: '10.1.0.12',
        eventId,
      });

      // Act
      const response = await POST(request, makeParams('hmac', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — externalId from the signed body flows into triggerExternalId,
      // inputData.triggerMeta.externalId, and (per-workflow scoped) dedupKey.
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            triggerExternalId: eventId,
            // hmac uses per-trigger scope: `hmac:<workflowId>:<externalId>` so different
            // workflows can legitimately reuse the same eventId without false-dedup.
            dedupKey: `hmac:${WORKFLOW_ID}:${eventId}`,
            inputData: expect.objectContaining({
              triggerMeta: expect.objectContaining({
                channel: 'hmac',
                externalId: eventId,
              }),
            }),
          }),
        })
      );
    });

    it('IGNORES an unsigned X-Sunrise-Event-Id header — adapter reads eventId from the signed body only', async () => {
      // Arrange — request has a valid signature but ALSO carries an unsigned
      // event-id header. The adapter MUST NOT propagate the header value into
      // the dedup key — doing so would let any captured request be replayed
      // by mutating only the header on each call. See security review Vuln 1.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_HMAC,
          channel: 'hmac',
          signingSecret: HMAC_TEST_SECRET,
        }) as never
      );

      const body = { action: 'no_event_id_in_body' };
      const rawBody = JSON.stringify(body);
      const ts = Math.floor(Date.now() / 1000);
      const { timestamp, signature } = signHookPayload(HMAC_TEST_SECRET, rawBody, ts);

      const request = new NextRequest(
        `http://localhost:3000/api/v1/inbound/hmac/${WORKFLOW_SLUG}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-sunrise-signature': signature,
            'x-sunrise-timestamp': timestamp,
            'x-forwarded-for': '10.1.0.13',
            // Unsigned header — must be ignored by the adapter
            'x-sunrise-event-id': 'evt_unsigned_attacker_value',
          },
          body: rawBody,
        }
      );

      // Act
      const response = await POST(request, makeParams('hmac', WORKFLOW_SLUG));

      // Assert — request still verifies (signature is valid over body), but the
      // unsigned header MUST NOT have leaked into triggerExternalId or dedupKey.
      expect(response.status).toBe(202);
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            triggerExternalId: null,
            dedupKey: null,
          }),
        })
      );
    });
  });

  describe('missing signingSecret on trigger row', () => {
    it('returns 401 when trigger row has no signingSecret', async () => {
      // Arrange — trigger exists but was created without a per-trigger secret.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_HMAC,
          channel: 'hmac',
          signingSecret: null, // fail-closed: missing secret config
        }) as never
      );

      const body = { action: 'ping' };
      const request = makeHmacRequest('hmac', WORKFLOW_SLUG, body, { ip: '10.1.0.20' });

      // Act
      const response = await POST(request, makeParams('hmac', WORKFLOW_SLUG));

      // Assert — adapter returns missing_secret_config → route returns 401.
      expect(response.status).toBe(401);
      const respBody = await parseJSON<ErrorEnvelope>(response);
      expect(respBody.success).toBe(false);
      expect(respBody.error.code).toBe('UNAUTHORIZED');

      // No execution row created.
      expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
    });
  });
});

// ─── Postmark channel ─────────────────────────────────────────────────────────

describe('Postmark channel', () => {
  describe('happy path', () => {
    const postmarkBody = {
      MessageID: 'msg-postmark-001',
      FromFull: { Email: 'sender@example.com', Name: 'Sender Name' },
      ToFull: [{ Email: 'inbox@example.com', Name: 'Inbox', MailboxHash: 'hash1' }],
      CcFull: [],
      Subject: 'Test inbound email',
      Date: '2026-05-07T10:00:00Z',
      TextBody: 'Hello from Postmark',
      HtmlBody: '<p>Hello from Postmark</p>',
      StrippedTextReply: '',
      MailboxHash: '',
      MessageStream: 'inbound',
      Attachments: [],
    };

    it('returns 202 with executionId for valid Postmark Basic-auth', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_POSTMARK,
          channel: 'postmark',
          signingSecret: null,
        }) as never
      );
      vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue(
        makeExecutionRow({
          id: EXECUTION_ID,
          triggerSource: 'inbound:postmark',
          triggerExternalId: 'msg-postmark-001',
        }) as never
      );

      const request = makePostmarkRequest('postmark', WORKFLOW_SLUG, postmarkBody, {
        ip: '10.2.0.10',
      });

      // Act
      const response = await POST(request, makeParams('postmark', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);
      const respBody =
        await parseJSON<ApiResponse<{ executionId: string; channel: string }>>(response);
      expect(respBody.success).toBe(true);
      if (respBody.success) {
        expect(respBody.data.executionId).toBe(EXECUTION_ID);
        expect(respBody.data.channel).toBe('postmark');
      }
    });

    it('calls prisma.aiWorkflowExecution.create with triggerSource inbound:postmark and MessageID as externalId', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_POSTMARK,
          channel: 'postmark',
          signingSecret: null,
        }) as never
      );

      const request = makePostmarkRequest('postmark', WORKFLOW_SLUG, postmarkBody, {
        ip: '10.2.0.11',
      });

      // Act
      const response = await POST(request, makeParams('postmark', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — triggerSource is inbound:postmark, externalId from MessageID,
      // and dedupKey is channel-global (`postmark:<MessageID>`) so cross-workflow
      // replays of the same Postmark MessageID collide. See security review Vuln 2.
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            triggerSource: 'inbound:postmark',
            triggerExternalId: 'msg-postmark-001',
            dedupKey: 'postmark:msg-postmark-001',
            versionId: VERSION_ID,
            userId: USER_ID,
          }),
        })
      );
    });

    it('normalises FromFull.Email into inputData.trigger.from.email', async () => {
      // Arrange
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_POSTMARK,
          channel: 'postmark',
          signingSecret: null,
        }) as never
      );

      const request = makePostmarkRequest('postmark', WORKFLOW_SLUG, postmarkBody, {
        ip: '10.2.0.12',
      });

      // Act
      const response = await POST(request, makeParams('postmark', WORKFLOW_SLUG));

      // Assert — status first
      expect(response.status).toBe(202);

      // Assert — from.email is correctly extracted from FromFull.
      expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            inputData: expect.objectContaining({
              trigger: expect.objectContaining({
                from: expect.objectContaining({ email: 'sender@example.com' }),
              }),
            }),
          }),
        })
      );
    });

    it('returns 401 on wrong Postmark credentials', async () => {
      // Arrange — trigger exists, but credentials are wrong.
      vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
        makeTriggerRow({
          id: TRIGGER_ID_POSTMARK,
          channel: 'postmark',
          signingSecret: null,
        }) as never
      );

      const request = makePostmarkRequest('postmark', WORKFLOW_SLUG, postmarkBody, {
        user: 'wrong-user',
        pass: 'wrong-pass',
        ip: '10.2.0.20',
      });

      // Act
      const response = await POST(request, makeParams('postmark', WORKFLOW_SLUG));

      // Assert
      expect(response.status).toBe(401);
      const respBody = await parseJSON<ErrorEnvelope>(response);
      expect(respBody.success).toBe(false);
      expect(respBody.error.code).toBe('UNAUTHORIZED');

      // No execution row on auth failure.
      expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
    });
  });
});

// ─── Event type filter ────────────────────────────────────────────────────────

describe('event type filter', () => {
  it('returns 200 with skipped:event_type_filtered when event type not in allow-list', async () => {
    // Arrange — trigger has eventTypes filter = ['app_mention'], but event is 'message'.
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({
        id: TRIGGER_ID_SLACK,
        channel: 'slack',
        metadata: { eventTypes: ['app_mention'] },
      }) as never
    );

    const body = {
      type: 'event_callback',
      event_id: 'Ev_FILTERED',
      event: { type: 'message', user: 'U12345', text: 'not a mention' },
    };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.3.0.10' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert — status first
    expect(response.status).toBe(200);
    const respBody = await parseJSON<ApiResponse<{ skipped: string }>>(response);
    expect(respBody.success).toBe(true);
    if (respBody.success) {
      expect(respBody.data.skipped).toBe('event_type_filtered');
    }

    // Filter path must NOT insert an execution row.
    expect(prisma.aiWorkflowExecution.create).not.toHaveBeenCalled();
  });

  it('proceeds normally when event type matches the allow-list', async () => {
    // Arrange — trigger allows 'app_mention' and event is 'app_mention'.
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({
        id: TRIGGER_ID_SLACK,
        channel: 'slack',
        metadata: { eventTypes: ['app_mention'] },
      }) as never
    );

    const body = {
      type: 'event_callback',
      event_id: 'Ev_ALLOWED',
      event: { type: 'app_mention', user: 'U12345', text: '<@bot> hello' },
    };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.3.0.11' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert — proceeds to 202
    expect(response.status).toBe(202);
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledTimes(1);
  });

  it('does not filter when metadata.eventTypes is empty array', async () => {
    // Arrange — empty eventTypes = accept all.
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({
        id: TRIGGER_ID_SLACK,
        channel: 'slack',
        metadata: { eventTypes: [] },
      }) as never
    );

    const body = {
      type: 'event_callback',
      event_id: 'Ev_EMPTY_FILTER',
      event: { type: 'message', user: 'U12345', text: 'any event' },
    };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.3.0.12' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert — empty filter list means no filtering applied.
    expect(response.status).toBe(202);
    expect(prisma.aiWorkflowExecution.create).toHaveBeenCalledTimes(1);
  });
});

// ─── Observability ────────────────────────────────────────────────────────────

describe('observability', () => {
  it('includes externalId in audit log metadata after successful Slack fire', async () => {
    // Arrange
    const eventId = 'Ev_OBSERVE_001';
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
    );
    vi.mocked(prisma.aiWorkflowExecution.create).mockResolvedValue(
      makeExecutionRow({ id: EXECUTION_ID }) as never
    );

    const body = {
      type: 'event_callback',
      event_id: eventId,
      event: { type: 'app_mention', user: 'U12345', text: 'observe me' },
    };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.4.0.10' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert — status first
    expect(response.status).toBe(202);

    // Assert — audit log must include the external event ID.
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow_trigger.fire',
        entityType: 'workflow_trigger',
        userId: USER_ID,
        metadata: expect.objectContaining({
          channel: 'slack',
          executionId: EXECUTION_ID,
          externalId: eventId,
        }),
      })
    );
  });

  it('calls lastFiredAt update (best-effort) for HMAC happy path', async () => {
    // Arrange
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({
        id: TRIGGER_ID_HMAC,
        channel: 'hmac',
        signingSecret: HMAC_TEST_SECRET,
      }) as never
    );

    const body = { action: 'observe_hmac' };
    const request = makeHmacRequest('hmac', WORKFLOW_SLUG, body, { ip: '10.4.0.20' });

    // Act
    const response = await POST(request, makeParams('hmac', WORKFLOW_SLUG));

    // Assert — status first
    expect(response.status).toBe(202);

    // Assert — lastFiredAt update was issued.
    await vi.waitFor(() => {
      expect(prisma.aiWorkflowTrigger.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TRIGGER_ID_HMAC },
          data: expect.objectContaining({ lastFiredAt: expect.any(Date) }),
        })
      );
    });
  });

  it('returns 202 even when lastFiredAt update rejects (best-effort)', async () => {
    // Arrange — lastFiredAt update fails; must not affect the 202 response.
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
    );
    vi.mocked(prisma.aiWorkflowTrigger.update).mockRejectedValue(new Error('DB write failed'));

    const body = {
      type: 'event_callback',
      event_id: 'Ev_BEST_EFFORT',
      event: { type: 'message' },
    };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.4.0.30' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert — 202 is returned despite the best-effort update failing.
    expect(response.status).toBe(202);
  });
});

// ─── Common error paths ───────────────────────────────────────────────────────

describe('error paths', () => {
  it('returns 404 when trigger row does not exist', async () => {
    // Arrange — findFirst returns null (default from beforeEach).
    const body = { type: 'event_callback', event: { type: 'message' } };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.5.0.10' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert
    expect(response.status).toBe(404);
    const respBody = await parseJSON<ErrorEnvelope>(response);
    expect(respBody.success).toBe(false);
    expect(respBody.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 when workflow has no publishedVersion', async () => {
    // Arrange — trigger exists but workflow has no published version.
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({
        workflow: {
          id: WORKFLOW_ID,
          slug: WORKFLOW_SLUG,
          publishedVersion: null, // no published version
        },
      }) as never
    );

    const body = { type: 'event_callback', event: { type: 'message' } };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.5.0.11' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert
    expect(response.status).toBe(404);
    const respBody = await parseJSON<ErrorEnvelope>(response);
    expect(respBody.success).toBe(false);
    expect(respBody.error.code).toBe('NOT_FOUND');
  });

  it('returns 500 on non-P2002 DB error during execution insert', async () => {
    // Arrange — a non-dedup DB error should surface as 500.
    vi.mocked(prisma.aiWorkflowTrigger.findFirst).mockResolvedValue(
      makeTriggerRow({ id: TRIGGER_ID_SLACK, channel: 'slack' }) as never
    );
    vi.mocked(prisma.aiWorkflowExecution.create).mockRejectedValue(
      new Error('Unexpected DB connection lost')
    );

    const body = {
      type: 'event_callback',
      event_id: 'Ev_DB_ERR',
      event: { type: 'message' },
    };
    const request = makeSlackRequest('slack', WORKFLOW_SLUG, body, { ip: '10.5.0.20' });

    // Act
    const response = await POST(request, makeParams('slack', WORKFLOW_SLUG));

    // Assert
    expect(response.status).toBe(500);
    const respBody = await parseJSON<ErrorEnvelope>(response);
    expect(respBody.success).toBe(false);
    expect(respBody.error.code).toBe('INTERNAL_ERROR');
  });
});
