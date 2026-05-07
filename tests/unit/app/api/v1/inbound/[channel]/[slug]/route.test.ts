/**
 * Unit Test: Inbound Trigger Route
 *
 * POST /api/v1/inbound/:channel/:slug
 *
 * Covers all branches of the trust-boundary inbound trigger handler
 * in source execution order:
 *   - Rate limiting gate
 *   - Channel + slug validation gates
 *   - Adapter not-configured gate
 *   - Body-read failure
 *   - Handshake short-circuit
 *   - Trigger / publishedVersion 404 paths
 *   - Verify failure paths (structured reason logged but NOT in response)
 *   - Adapter.verify throws (defensive 401, not 500)
 *   - Normalise → event-type filter (200 skipped)
 *   - Workflow definition parse failure (500)
 *   - Happy path: 202 + execution create + audit log + drainEngine
 *   - Dedup: P2002 on triggerExternalId → 200 deduped
 *   - Non-P2002 Prisma error → 500
 *   - Non-Prisma error → 500
 *
 * Anti-green-bar discipline: if a test fails, the FIRST hypothesis is that the
 * source has a bug. Do NOT adjust assertions to match observed behavior without
 * auditing the source.
 *
 * @see app/api/v1/inbound/[channel]/[slug]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { parseJSON } from '@/tests/helpers/assertions';

// ─── Hoisted mock refs ────────────────────────────────────────────────────────
// vi.hoisted() ensures these exist before any vi.mock() factory runs.

const {
  mockFindFirst,
  mockExecutionCreate,
  mockTriggerUpdate,
  mockInboundLimiterCheck,
  mockCreateRateLimitResponse,
  mockGetClientIP,
  mockGetInboundAdapter,
  mockBootstrapInboundAdapters,
  mockDrainEngine,
  mockLogAdminAction,
  mockLogger,
} = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockExecutionCreate: vi.fn(),
  mockTriggerUpdate: vi.fn(),
  mockInboundLimiterCheck: vi.fn(() => ({ success: true })),
  mockCreateRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
  mockGetClientIP: vi.fn(() => '10.0.0.1'),
  mockGetInboundAdapter: vi.fn(),
  mockBootstrapInboundAdapters: vi.fn(),
  mockDrainEngine: vi.fn(() => Promise.resolve()),
  mockLogAdminAction: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowTrigger: {
      findFirst: mockFindFirst,
      update: mockTriggerUpdate,
    },
    aiWorkflowExecution: {
      create: mockExecutionCreate,
    },
  },
}));

vi.mock('@/lib/security/rate-limit', () => ({
  inboundLimiter: { check: mockInboundLimiterCheck },
  createRateLimitResponse: mockCreateRateLimitResponse,
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: mockGetClientIP,
}));

vi.mock('@/lib/orchestration/inbound/registry', () => ({
  getInboundAdapter: mockGetInboundAdapter,
}));

vi.mock('@/lib/orchestration/inbound/bootstrap', () => ({
  bootstrapInboundAdapters: mockBootstrapInboundAdapters,
}));

vi.mock('@/lib/orchestration/scheduling/scheduler', () => ({
  drainEngine: mockDrainEngine,
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: mockLogAdminAction,
}));

vi.mock('@/lib/logging', () => ({
  logger: mockLogger,
}));

// NOTE: @/lib/validations/orchestration is NOT mocked — real Zod parsing.

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { POST } from '@/app/api/v1/inbound/[channel]/[slug]/route';

// ─── Response shapes ──────────────────────────────────────────────────────────

interface SuccessBody<T = unknown> {
  success: true;
  data: T;
}

interface ErrorBody {
  success: false;
  error: { code: string; message: string };
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * A minimal valid workflowDefinitionSchema snapshot.
 * workflowDefinitionSchema requires:
 *   steps: array of workflowStepSchema (min 1)
 *   entryStepId: string (min 1)
 *   errorStrategy: enum ['retry','fallback','skip','fail']
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
  errorStrategy: 'fail',
};

/** An invalid snapshot that fails workflowDefinitionSchema.safeParse */
const INVALID_SNAPSHOT = { steps: [] }; // min(1) violation

/** A factory for the trigger row returned by findFirst */
function makeTrigger(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trigger-id-1',
    name: 'Test Trigger',
    channel: 'slack',
    isEnabled: true,
    createdBy: 'user-abc',
    signingSecret: 'secret-value',
    metadata: null,
    workflow: {
      id: 'workflow-id-1',
      slug: 'my-workflow',
      publishedVersion: {
        id: 'version-id-1',
        snapshot: VALID_SNAPSHOT,
      },
    },
    ...overrides,
  };
}

/** A factory for the execution row returned by create */
function makeExecution(overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-id-1',
    ...overrides,
  };
}

/** A factory for a minimal passing adapter (verify always valid, no handshake) */
function makeAdapter(
  overrides: Partial<{
    channel: string;
    handleHandshake: ((body: unknown) => Response | null) | undefined;
    verify: () => Promise<{ valid: boolean; reason?: string; externalId?: string }>;
    normalise: () => {
      channel: string;
      payload: Record<string, unknown>;
      externalId?: string;
      eventType?: string;
    };
  }> = {}
) {
  return {
    channel: 'slack',
    verify: vi.fn().mockResolvedValue({ valid: true, externalId: 'evt-123' }),
    normalise: vi.fn().mockReturnValue({
      channel: 'slack',
      payload: { text: 'hello' },
      externalId: 'evt-123',
      eventType: 'message',
    }),
    ...overrides,
  };
}

/** Build a NextRequest targeting the inbound route */
function makeRequest(
  body: string | null = JSON.stringify({ type: 'event_callback', event_id: 'evt-123' }),
  method = 'POST',
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest('http://localhost:3000/api/v1/inbound/slack/my-workflow', {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body !== null ? { body } : {}),
  });
}

/** Build the params object (Promise<{channel, slug}>) */
function makeParams(channel = 'slack', slug = 'my-workflow') {
  return { params: Promise.resolve({ channel, slug }) };
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  // Reset to safe defaults: rate limit passes, adapter found, trigger found,
  // execution succeeds, trigger update succeeds.
  mockInboundLimiterCheck.mockReturnValue({ success: true });
  mockGetClientIP.mockReturnValue('10.0.0.1');
  mockGetInboundAdapter.mockReturnValue(makeAdapter());
  mockFindFirst.mockResolvedValue(makeTrigger());
  mockExecutionCreate.mockResolvedValue(makeExecution());
  mockTriggerUpdate.mockResolvedValue({});
  mockDrainEngine.mockResolvedValue(undefined);
  mockLogAdminAction.mockReturnValue(undefined);
});

// ─── Pre-lookup gates ─────────────────────────────────────────────────────────

describe('rate limit gate', () => {
  it('returns 429 when inboundLimiter.check returns success:false', async () => {
    // Arrange
    mockInboundLimiterCheck.mockReturnValue({ success: false });

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert — rate limit response called + returned
    expect(response.status).toBe(429);
    expect(mockCreateRateLimitResponse).toHaveBeenCalledOnce();
    // Adapter should not have been consulted — we bailed before it
    expect(mockGetInboundAdapter).not.toHaveBeenCalled();
  });
});

describe('channel validation gate', () => {
  it('returns 404 NOT_FOUND when channel contains uppercase characters', async () => {
    // Arrange — uppercase 'S' fails channelSchema regex
    const request = makeRequest();

    // Act
    const response = await POST(request, makeParams('Slack', 'my-workflow'));
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND when channel contains special characters', async () => {
    // Arrange
    const request = makeRequest();

    // Act
    const response = await POST(request, makeParams('slack!', 'my-workflow'));
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('slug validation gate', () => {
  it('returns 404 NOT_FOUND when slug contains uppercase characters', async () => {
    // Arrange
    const request = makeRequest();

    // Act
    const response = await POST(request, makeParams('slack', 'My-Workflow'));
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND when slug contains special characters', async () => {
    // Arrange
    const request = makeRequest();

    // Act
    const response = await POST(request, makeParams('slack', 'my_workflow'));
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('adapter not configured gate', () => {
  it('returns 404 NOT_FOUND when getInboundAdapter returns null', async () => {
    // Arrange — no adapter registered for this channel
    mockGetInboundAdapter.mockReturnValue(null);

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert — 404, NOT 503 so probes can't distinguish missing vs disabled
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    // Trigger lookup must NOT have happened
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

// ─── Handshake short-circuit ──────────────────────────────────────────────────

describe('handshake short-circuit', () => {
  it('returns the handshake Response verbatim and skips trigger lookup when handleHandshake returns a Response', async () => {
    // Arrange — adapter returns a handshake response
    const handshakeResponse = new Response('challenge-token', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        handleHandshake: vi.fn().mockReturnValue(handshakeResponse),
      })
    );

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert — same response object; trigger lookup MUST NOT have been called
    expect(response.status).toBe(200);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it('proceeds to verify path when adapter has no handleHandshake method', async () => {
    // Arrange — adapter without handleHandshake
    mockGetInboundAdapter.mockReturnValue(makeAdapter({ handleHandshake: undefined }));

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert — reaches trigger lookup (verify path executed)
    expect(mockFindFirst).toHaveBeenCalledOnce();
    // Happy path gives 202
    expect(response.status).toBe(202);
  });

  it('proceeds to verify path when handleHandshake returns null (fall-through)', async () => {
    // Arrange — adapter has handleHandshake but returns null (not a handshake request)
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        handleHandshake: vi.fn().mockReturnValue(null),
      })
    );

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert — trigger lookup was reached
    expect(mockFindFirst).toHaveBeenCalledOnce();
    expect(response.status).toBe(202);
  });
});

// ─── Body read failure ────────────────────────────────────────────────────────

describe('body read failure', () => {
  it('returns 400 VALIDATION_ERROR when request.text() throws', async () => {
    // Arrange — spy on request.text to throw (simulates malformed body stream)
    const request = makeRequest();
    vi.spyOn(request, 'text').mockRejectedValue(new Error('stream error'));

    // Act
    const response = await POST(request, makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Trigger lookup MUST NOT have happened
    expect(mockFindFirst).not.toHaveBeenCalled();
  });
});

// ─── Verify failure paths ─────────────────────────────────────────────────────

describe('verify failure — reason logged but not surfaced', () => {
  const reasons = [
    'missing_signature',
    'bad_format',
    'stale_timestamp',
    'bad_signature',
    'missing_secret_config',
    'unauthorized',
  ] as const;

  for (const reason of reasons) {
    it(`returns 401 UNAUTHORIZED and logs reason "${reason}" without including it in the response body`, async () => {
      // Arrange — adapter verify returns structured failure
      mockGetInboundAdapter.mockReturnValue(
        makeAdapter({
          verify: vi.fn().mockResolvedValue({ valid: false, reason }),
        })
      );

      // Act
      const response = await POST(makeRequest(), makeParams());
      const body = await parseJSON<ErrorBody>(response);

      // Assert: response must NOT contain the reason (security: attackers can't probe)
      expect(response.status).toBe(401);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(JSON.stringify(body)).not.toContain(reason);

      // Assert: reason IS logged internally via logger.warn
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Inbound: signature verification failed',
        expect.objectContaining({ reason })
      );
    });
  }
});

describe('verify throws (defensive try/catch)', () => {
  it('returns 401 UNAUTHORIZED (not 500) when adapter.verify throws', async () => {
    // Arrange — adapter.verify throws an unexpected error
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        verify: vi.fn().mockRejectedValue(new Error('unexpected adapter crash')),
      })
    );

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert — defensive 401, not 500 (error propagation must not leak)
    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
    // Error is logged at error level, not surfaced to caller
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

// ─── Trigger lookup failures ──────────────────────────────────────────────────

describe('trigger lookup', () => {
  it('returns 404 NOT_FOUND when no trigger row exists for (channel, slug, isEnabled)', async () => {
    // Arrange — no matching trigger
    mockFindFirst.mockResolvedValue(null);

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('returns 404 NOT_FOUND when trigger workflow has no publishedVersion', async () => {
    // Arrange — trigger exists but workflow has no published version
    mockFindFirst.mockResolvedValue(
      makeTrigger({
        workflow: {
          id: 'workflow-id-1',
          slug: 'my-workflow',
          publishedVersion: null,
        },
      })
    );

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Inbound: workflow has no published version',
      expect.objectContaining({ workflowId: 'workflow-id-1' })
    );
  });
});

// ─── Workflow definition parse failure ────────────────────────────────────────

describe('workflow definition snapshot validation', () => {
  it('returns 500 INTERNAL_ERROR when workflowDefinitionSchema.safeParse fails on snapshot', async () => {
    // Arrange — snapshot fails Zod validation (empty steps array)
    mockFindFirst.mockResolvedValue(
      makeTrigger({
        workflow: {
          id: 'workflow-id-1',
          slug: 'my-workflow',
          publishedVersion: {
            id: 'version-id-1',
            snapshot: INVALID_SNAPSHOT,
          },
        },
      })
    );

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    // Execution must NOT have been created
    expect(mockExecutionCreate).not.toHaveBeenCalled();
  });
});

// ─── Event-type filter ────────────────────────────────────────────────────────

describe('event-type filter', () => {
  it('returns 200 with skipped:event_type_filtered when normalised eventType is not in metadata.eventTypes', async () => {
    // Arrange — trigger only accepts 'app_mention'; adapter returns 'message'
    mockFindFirst.mockResolvedValue(makeTrigger({ metadata: { eventTypes: ['app_mention'] } }));
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        normalise: vi.fn().mockReturnValue({
          channel: 'slack',
          payload: { text: 'hello' },
          eventType: 'message',
        }),
        verify: vi.fn().mockResolvedValue({ valid: true }),
      })
    );

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<SuccessBody<{ skipped: string }>>(response);

    // Assert — filtered but not an error
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.skipped).toBe('event_type_filtered');
    // Execution MUST NOT have been inserted
    expect(mockExecutionCreate).not.toHaveBeenCalled();
  });

  it('does NOT filter when metadata.eventTypes is empty array', async () => {
    // Arrange — empty eventTypes means accept all
    mockFindFirst.mockResolvedValue(makeTrigger({ metadata: { eventTypes: [] } }));

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert — proceeds to execution creation (not filtered)
    expect(mockExecutionCreate).toHaveBeenCalledOnce();
    expect(response.status).toBe(202);
  });

  it('does NOT filter when normalised eventType is undefined', async () => {
    // Arrange — trigger has allow-list but adapter returns no eventType
    mockFindFirst.mockResolvedValue(makeTrigger({ metadata: { eventTypes: ['app_mention'] } }));
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        normalise: vi.fn().mockReturnValue({
          channel: 'slack',
          payload: { text: 'hello' },
          // no eventType
        }),
        verify: vi.fn().mockResolvedValue({ valid: true }),
      })
    );

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert — no eventType means filter does not apply
    expect(mockExecutionCreate).toHaveBeenCalledOnce();
    expect(response.status).toBe(202);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe('happy path', () => {
  it('returns 202 with executionId, channel, workflowSlug, status:pending on success', async () => {
    // Arrange — defaults set in beforeEach

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<
      SuccessBody<{
        executionId: string;
        channel: string;
        workflowSlug: string;
        status: string;
      }>
    >(response);

    // Assert
    expect(response.status).toBe(202);
    expect(body.success).toBe(true);
    expect(body.data.executionId).toBe('exec-id-1');
    expect(body.data.channel).toBe('slack');
    expect(body.data.workflowSlug).toBe('my-workflow');
    expect(body.data.status).toBe('pending');
  });

  it('calls prisma.aiWorkflowExecution.create with correct triggerSource, versionId, and userId', async () => {
    // Arrange — defaults set in beforeEach

    // Act
    await POST(makeRequest(), makeParams());

    // Assert — source is 'inbound:<channel>'
    expect(mockExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          triggerSource: 'inbound:slack',
          versionId: 'version-id-1',
          userId: 'user-abc',
          status: 'pending',
        }),
      })
    );
  });

  it('sets triggerExternalId from verify result (verify externalId takes priority over normalised)', async () => {
    // Arrange — verify returns externalId 'verify-ext-id'; normalise returns different one
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        verify: vi.fn().mockResolvedValue({ valid: true, externalId: 'verify-ext-id' }),
        normalise: vi.fn().mockReturnValue({
          channel: 'slack',
          payload: { text: 'hello' },
          externalId: 'normalise-ext-id',
          eventType: 'message',
        }),
      })
    );

    // Act
    await POST(makeRequest(), makeParams());

    // Assert — verify's externalId wins
    expect(mockExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          triggerExternalId: 'verify-ext-id',
        }),
      })
    );
  });

  it('puts normalised.payload into inputData.trigger and externalId into inputData.triggerMeta.externalId', async () => {
    // Arrange — adapter provides specific payload shape
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        verify: vi.fn().mockResolvedValue({ valid: true, externalId: 'evt-789' }),
        normalise: vi.fn().mockReturnValue({
          channel: 'slack',
          payload: { text: 'hello world', user: 'U123' },
          externalId: 'evt-789',
          eventType: 'message',
        }),
      })
    );

    // Act
    await POST(makeRequest(), makeParams());

    // Assert — inputData structure
    expect(mockExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          inputData: expect.objectContaining({
            trigger: { text: 'hello world', user: 'U123' },
            triggerMeta: expect.objectContaining({
              externalId: 'evt-789',
              channel: 'slack',
            }),
          }),
        }),
      })
    );
  });

  it('computes dedupKey as `<channel>:<externalId>` for shared-secret channels (slack)', async () => {
    // Arrange — Slack default; verify returns no externalId so normalise wins
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        verify: vi.fn().mockResolvedValue({ valid: true }),
        normalise: vi.fn().mockReturnValue({
          channel: 'slack',
          payload: { text: 'hi' },
          externalId: 'Ev01ABCDEF',
          eventType: 'app_mention',
        }),
      })
    );

    // Act
    await POST(makeRequest(), makeParams());

    // Assert — dedupKey is channel-global so cross-workflow Slack replays collide
    expect(mockExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupKey: 'slack:Ev01ABCDEF' }),
      })
    );
  });

  it('computes dedupKey as `<channel>:<externalId>` for shared-secret channels (postmark)', async () => {
    // Arrange — postmark adapter
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        channel: 'postmark',
        verify: vi.fn().mockResolvedValue({ valid: true }),
        normalise: vi.fn().mockReturnValue({
          channel: 'postmark',
          payload: { from: { email: 'a@b' } },
          externalId: 'msg-123',
          eventType: 'inbound_email',
        }),
      })
    );

    // Act
    await POST(makeRequest(), makeParams('postmark'));

    // Assert — postmark also uses channel-global scope
    expect(mockExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupKey: 'postmark:msg-123' }),
      })
    );
  });

  it('computes dedupKey as `hmac:<workflowId>:<externalId>` for per-trigger HMAC channel', async () => {
    // Arrange — hmac channel; per-trigger secret means cross-workflow collision is impossible
    // (different secrets produce different valid signatures), so the dedup scope stays per-workflow
    // to allow unrelated triggers to legitimately reuse the same eventId.
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        channel: 'hmac',
        verify: vi.fn().mockResolvedValue({ valid: true }),
        normalise: vi.fn().mockReturnValue({
          channel: 'hmac',
          payload: { body: { eventId: 'evt-xyz' } },
          externalId: 'evt-xyz',
        }),
      })
    );

    // Act
    await POST(makeRequest(), makeParams('hmac'));

    // Assert — hmac scope includes the workflow id
    expect(mockExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupKey: 'hmac:workflow-id-1:evt-xyz' }),
      })
    );
  });

  it('sets dedupKey to null when no externalId is present (no dedup)', async () => {
    // Arrange — adapter returns no externalId at all
    mockGetInboundAdapter.mockReturnValue(
      makeAdapter({
        verify: vi.fn().mockResolvedValue({ valid: true }),
        normalise: vi.fn().mockReturnValue({
          channel: 'slack',
          payload: { text: 'hi' },
        }),
      })
    );

    // Act
    await POST(makeRequest(), makeParams());

    // Assert — null dedupKey means each call inserts a new row (Postgres NULL-distinct)
    expect(mockExecutionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dedupKey: null }),
      })
    );
  });

  it('calls drainEngine fire-and-forget with the new executionId and parsed definition', async () => {
    // Arrange — defaults set in beforeEach

    // Act
    await POST(makeRequest(), makeParams());

    // Assert — drainEngine called with executionId + workflow object + definition
    expect(mockDrainEngine).toHaveBeenCalledWith(
      'exec-id-1',
      expect.objectContaining({ id: 'workflow-id-1', slug: 'my-workflow' }),
      expect.objectContaining({ steps: expect.any(Array) }),
      expect.any(Object),
      'user-abc',
      'version-id-1'
    );
  });

  it('calls logAdminAction with action:workflow_trigger.fire, channel, and executionId', async () => {
    // Arrange — defaults set in beforeEach

    // Act
    await POST(makeRequest(), makeParams());

    // Assert — audit log entry contains required fields
    expect(mockLogAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workflow_trigger.fire',
        entityType: 'workflow_trigger',
        metadata: expect.objectContaining({
          channel: 'slack',
          executionId: 'exec-id-1',
        }),
      })
    );
  });

  it('calls aiWorkflowTrigger.update for lastFiredAt as best-effort (rejection does NOT prevent 202)', async () => {
    // Arrange — update rejects; 202 must still be returned
    mockTriggerUpdate.mockRejectedValue(new Error('lastFiredAt update failed'));

    // Act
    const response = await POST(makeRequest(), makeParams());

    // Assert — 202 returned despite update failure
    expect(response.status).toBe(202);
    expect(mockTriggerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'trigger-id-1' },
        data: expect.objectContaining({ lastFiredAt: expect.any(Date) }),
      })
    );
  });
});

// ─── Dedup paths ──────────────────────────────────────────────────────────────

describe('dedup', () => {
  it('returns 200 with deduped:true when create throws P2002 on dedupKey', async () => {
    // Arrange — construct a Prisma P2002 error targeting dedupKey (the route's
    // computed-per-channel collision key — see route.ts dedupKey assignment).
    const p2002Error = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`dedupKey`)',
      {
        code: 'P2002',
        clientVersion: '7.0.0',
        meta: { target: ['dedupKey'] },
      }
    );
    mockExecutionCreate.mockRejectedValue(p2002Error);

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<SuccessBody<{ deduped: boolean }>>(response);

    // Assert — replay acknowledged with 200, not 500
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.deduped).toBe(true);
  });

  it('returns 500 INTERNAL_ERROR when create throws a non-P2002 Prisma error', async () => {
    // Arrange — P2025 (record not found in nested select during create) — unrelated to dedup
    const p2025Error = new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
      code: 'P2025',
      clientVersion: '7.0.0',
      meta: {},
    });
    mockExecutionCreate.mockRejectedValue(p2025Error);

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert — non-dedup Prisma errors are not swallowed
    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 INTERNAL_ERROR when create throws a P2002 that targets a different field (not dedupKey)', async () => {
    // Arrange — P2002 on a different constraint (e.g. workflowId + status) must NOT dedup
    const p2002WrongField = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed on the fields: (`workflowId`,`status`)',
      {
        code: 'P2002',
        clientVersion: '7.0.0',
        meta: { target: ['workflowId', 'status'] },
      }
    );
    mockExecutionCreate.mockRejectedValue(p2002WrongField);

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert — wrong-field P2002 is not treated as a dedup
    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('returns 500 INTERNAL_ERROR when create throws a non-Prisma error', async () => {
    // Arrange — generic JS error (network, serialization, etc.)
    mockExecutionCreate.mockRejectedValue(new Error('unexpected failure'));

    // Act
    const response = await POST(makeRequest(), makeParams());
    const body = await parseJSON<ErrorBody>(response);

    // Assert
    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });
});
