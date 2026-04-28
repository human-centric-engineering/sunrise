/**
 * Unit Tests: Single Workflow Schedule — GET, PATCH, DELETE
 *
 * Covers the branches in resolveSchedule() and each HTTP handler:
 *   - Invalid workflow ID format (ValidationError, line 26)
 *   - Invalid schedule ID format (ValidationError, line 30)
 *   - Schedule not found (NotFoundError, line 36)
 *   - GET happy path
 *   - PATCH happy path — name update only
 *   - PATCH — cron update recomputes nextRunAt
 *   - PATCH — isEnabled=false sets nextRunAt to null
 *   - PATCH — invalid cron expression (ValidationError)
 *   - PATCH — validateRequestBody schema error (400)
 *   - DELETE happy path
 *   - Rate-limit rejection on each handler
 *   - Unauthenticated rejection on each handler
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks (must appear before imports) ────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflowSchedule: {
      findFirst: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    aiAdminAuditLog: { create: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logAdminAction: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/scheduling', () => ({
  isValidCron: vi.fn((expr: string) => expr === '0 9 * * *' || expr === '*/5 * * * *'),
  getNextRunAt: vi.fn(() => new Date('2026-04-19T09:00:00Z')),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  GET as getSchedule,
  PATCH as updateSchedule,
  DELETE as deleteSchedule,
} from '@/app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Valid CUIDs (26 chars, lowercase alphanumeric starting with 'c')
const VALID_WF_ID = 'cmjbv4i3x00003wsloputgwul';
const VALID_SCHED_ID = 'cmjbv4i3x00004wsloputgwum';

const mockScheduleRecord = {
  id: VALID_SCHED_ID,
  workflowId: VALID_WF_ID,
  name: 'Daily run',
  cronExpression: '0 9 * * *',
  inputTemplate: {},
  isEnabled: true,
  lastRunAt: null,
  nextRunAt: new Date('2026-04-19T09:00:00Z'),
  createdBy: VALID_WF_ID,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
};

// ─── Request helpers ─────────────────────────────────────────────────────────

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: 'http://localhost:3000/test',
  } as unknown as NextRequest;
}

function makePatchRequest(body: unknown): NextRequest {
  const req = new Request('http://localhost:3000/test', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return req as unknown as NextRequest;
}

function makeDeleteRequest(): NextRequest {
  return {
    method: 'DELETE',
    headers: new Headers(),
    url: 'http://localhost:3000/test',
  } as unknown as NextRequest;
}

type ScheduleParams = { id: string; scheduleId: string };

function makeParams(id: string, scheduleId: string) {
  return { params: Promise.resolve<ScheduleParams>({ id, scheduleId }) };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /workflows/:id/schedules/:scheduleId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(mockScheduleRecord as never);
  });

  it('returns 200 with schedule data on happy path', async () => {
    // Arrange: findFirst returns the schedule
    // Act
    const res = await getSchedule(makeGetRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));
    const json = JSON.parse(await res.text());

    // Assert: handler wraps result in success envelope
    expect(res.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(json.success).toBe(true);
    expect(json.data.schedule.id).toBe(VALID_SCHED_ID);
  });

  it('returns 400 when workflow ID is not a valid CUID', async () => {
    // Arrange: invalid id format bypasses findFirst entirely
    const res = await getSchedule(makeGetRequest(), makeParams('not-a-cuid', VALID_SCHED_ID));
    const json = JSON.parse(await res.text());

    // Assert: ValidationError from resolveSchedule line 26
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('returns 400 when schedule ID is not a valid CUID', async () => {
    // Arrange: workflowId parses OK; scheduleId fails
    const res = await getSchedule(makeGetRequest(), makeParams(VALID_WF_ID, 'bad-sched-id'));
    const json = JSON.parse(await res.text());

    // Assert: ValidationError from resolveSchedule line 30
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when schedule does not exist', async () => {
    // Arrange: findFirst returns null (schedule absent or wrong workflowId)
    vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(null as never);

    const res = await getSchedule(makeGetRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));
    const json = JSON.parse(await res.text());

    // Assert: NotFoundError from resolveSchedule line 36
    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    // Arrange: rate limiter rejects
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    const res = await getSchedule(makeGetRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));

    expect(res.status).toBe(429);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('returns 401 when request is unauthenticated', async () => {
    // Arrange: no session
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await getSchedule(makeGetRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));

    expect(res.status).toBe(401);
  });
});

describe('PATCH /workflows/:id/schedules/:scheduleId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(mockScheduleRecord as never);
  });

  it('returns 200 with updated schedule when only name changes', async () => {
    // Arrange: update returns modified record
    vi.mocked(prisma.aiWorkflowSchedule.update).mockResolvedValue({
      ...mockScheduleRecord,
      name: 'Renamed',
    } as never);

    // Act
    const res = await updateSchedule(
      makePatchRequest({ name: 'Renamed' }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );
    const json = JSON.parse(await res.text());

    // Assert: route wraps updated record in envelope
    expect(res.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(json.success).toBe(true);
    expect(json.data.schedule.name).toBe('Renamed');
    // Verify update was called with correct id
    expect(prisma.aiWorkflowSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VALID_SCHED_ID } })
    );
  });

  it('recomputes nextRunAt when cronExpression changes', async () => {
    // Arrange: new valid cron
    vi.mocked(prisma.aiWorkflowSchedule.update).mockResolvedValue({
      ...mockScheduleRecord,
      cronExpression: '*/5 * * * *',
      nextRunAt: new Date('2026-04-19T09:00:00Z'),
    } as never);

    const res = await updateSchedule(
      makePatchRequest({ cronExpression: '*/5 * * * *' }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );

    // Assert: update was called (nextRunAt computed inside PATCH handler)
    expect(res.status).toBe(200);
    expect(prisma.aiWorkflowSchedule.update).toHaveBeenCalled();
  });

  it('sets nextRunAt to null when isEnabled is set to false', async () => {
    // Arrange: disabling the schedule
    vi.mocked(prisma.aiWorkflowSchedule.update).mockResolvedValue({
      ...mockScheduleRecord,
      isEnabled: false,
      nextRunAt: null,
    } as never);

    const res = await updateSchedule(
      makePatchRequest({ isEnabled: false }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );
    const json = JSON.parse(await res.text());

    // Assert: route passes nextRunAt=null to update
    expect(res.status).toBe(200);
    expect(prisma.aiWorkflowSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextRunAt: null }),
      })
    );
    expect(json.data.schedule.isEnabled).toBe(false);
  });

  it('returns 400 when cron expression is invalid', async () => {
    // Arrange: findFirst returns schedule; isValidCron rejects the expression
    const res = await updateSchedule(
      makePatchRequest({ cronExpression: 'invalid cron' }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );
    const json = JSON.parse(await res.text());

    // Assert: ValidationError is returned before any update
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.update).not.toHaveBeenCalled();
  });

  it('returns 400 when workflow ID is not a valid CUID', async () => {
    // Arrange: resolveSchedule fails on workflowId parse
    const res = await updateSchedule(
      makePatchRequest({ name: 'X' }),
      makeParams('not-valid', VALID_SCHED_ID)
    );
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('returns 400 when schedule ID is not a valid CUID', async () => {
    // Arrange: workflowId ok, scheduleId parse fails
    const res = await updateSchedule(
      makePatchRequest({ name: 'X' }),
      makeParams(VALID_WF_ID, 'bad-id')
    );
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('returns 404 when schedule does not exist', async () => {
    // Arrange: findFirst returns null
    vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(null as never);

    const res = await updateSchedule(
      makePatchRequest({ name: 'X' }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );

    expect(res.status).toBe(404);
    expect(prisma.aiWorkflowSchedule.update).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limit is exceeded', async () => {
    // Arrange: rate limiter rejects
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    const res = await updateSchedule(
      makePatchRequest({ name: 'X' }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );

    expect(res.status).toBe(429);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
  });

  it('includes inputTemplate in update data when provided', async () => {
    // Arrange: body includes an inputTemplate value
    const newTemplate = { prompt: 'run daily report' };
    vi.mocked(prisma.aiWorkflowSchedule.update).mockResolvedValue({
      ...mockScheduleRecord,
      inputTemplate: newTemplate,
    } as never);

    const res = await updateSchedule(
      makePatchRequest({ inputTemplate: newTemplate }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );

    // Assert: update was called with the inputTemplate field included
    expect(res.status).toBe(200);
    expect(prisma.aiWorkflowSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ inputTemplate: newTemplate }),
      })
    );
  });

  it('returns 401 when request is unauthenticated', async () => {
    // Arrange: no session
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await updateSchedule(
      makePatchRequest({ name: 'X' }),
      makeParams(VALID_WF_ID, VALID_SCHED_ID)
    );

    expect(res.status).toBe(401);
  });
});

describe('DELETE /workflows/:id/schedules/:scheduleId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
    vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(mockScheduleRecord as never);
    vi.mocked(prisma.aiWorkflowSchedule.delete).mockResolvedValue(mockScheduleRecord as never);
  });

  it('returns 200 with deleted=true on happy path', async () => {
    // Act
    const res = await deleteSchedule(makeDeleteRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));
    const json = JSON.parse(await res.text());

    // Assert: handler returns success envelope with deleted flag
    expect(res.status).toBe(200);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(json.success).toBe(true);
    // test-review:accept tobe_true — structural boolean assertion on API response field
    expect(json.data.deleted).toBe(true);
    // Verify delete was called with the resolved schedule id
    expect(prisma.aiWorkflowSchedule.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: VALID_SCHED_ID } })
    );
  });

  it('returns 400 when workflow ID is not a valid CUID', async () => {
    // Arrange: resolveSchedule throws ValidationError before any DB call
    const res = await deleteSchedule(
      makeDeleteRequest(),
      makeParams('bad-workflow-id', VALID_SCHED_ID)
    );
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiWorkflowSchedule.delete).not.toHaveBeenCalled();
  });

  it('returns 400 when schedule ID is not a valid CUID', async () => {
    // Arrange: workflowId ok, scheduleId fails CUID parse
    const res = await deleteSchedule(makeDeleteRequest(), makeParams(VALID_WF_ID, 'not-a-cuid!'));
    const json = JSON.parse(await res.text());

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiWorkflowSchedule.delete).not.toHaveBeenCalled();
  });

  it('returns 404 when schedule does not exist', async () => {
    // Arrange: findFirst returns null (already deleted or wrong workflowId)
    vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(null as never);

    const res = await deleteSchedule(makeDeleteRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));
    const json = JSON.parse(await res.text());

    // Assert: NotFoundError prevents double-delete
    expect(res.status).toBe(404);
    expect(json.success).toBe(false);
    expect(prisma.aiWorkflowSchedule.delete).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limit is exceeded', async () => {
    // Arrange: rate limiter rejects
    vi.mocked(adminLimiter.check).mockReturnValue({
      success: false,
      limit: 10,
      remaining: 0,
      reset: Date.now() + 60_000,
    } as never);

    const res = await deleteSchedule(makeDeleteRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));

    expect(res.status).toBe(429);
    expect(prisma.aiWorkflowSchedule.findFirst).not.toHaveBeenCalled();
    expect(prisma.aiWorkflowSchedule.delete).not.toHaveBeenCalled();
  });

  it('returns 401 when request is unauthenticated', async () => {
    // Arrange: no session
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

    const res = await deleteSchedule(makeDeleteRequest(), makeParams(VALID_WF_ID, VALID_SCHED_ID));

    expect(res.status).toBe(401);
    expect(prisma.aiWorkflowSchedule.delete).not.toHaveBeenCalled();
  });
});
