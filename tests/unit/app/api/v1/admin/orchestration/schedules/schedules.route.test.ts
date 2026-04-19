/**
 * Unit Test: Schedule CRUD endpoints + scheduler tick
 *
 * Covers:
 * - GET  /workflows/:id/schedules — list schedules
 * - POST /workflows/:id/schedules — create schedule
 * - GET  /workflows/:id/schedules/:scheduleId — get single schedule
 * - PATCH /workflows/:id/schedules/:scheduleId — update schedule
 * - DELETE /workflows/:id/schedules/:scheduleId — delete schedule
 * - POST /schedules/tick — trigger scheduler tick
 *
 * @see app/api/v1/admin/orchestration/workflows/[id]/schedules/route.ts
 * @see app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route.ts
 * @see app/api/v1/admin/orchestration/schedules/tick/route.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: { findUnique: vi.fn() },
    aiWorkflowSchedule: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
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
  processDueSchedules: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import {
  GET as listSchedules,
  POST as createSchedule,
} from '@/app/api/v1/admin/orchestration/workflows/[id]/schedules/route';
import {
  GET as getSchedule,
  PATCH as updateSchedule,
  DELETE as deleteSchedule,
} from '@/app/api/v1/admin/orchestration/workflows/[id]/schedules/[scheduleId]/route';
import { POST as tickScheduler } from '@/app/api/v1/admin/orchestration/schedules/tick/route';
import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { adminLimiter } from '@/lib/security/rate-limit';
import { processDueSchedules } from '@/lib/orchestration/scheduling';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

const VALID_WF_ID = 'cmjbv4i3x00003wsloputgwul';
const VALID_SCHED_ID = 'cmjbv4i3x00004wsloputgwum';

function makeGetRequest(): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: 'http://localhost:3000/test',
  } as unknown as NextRequest;
}

function makePostRequest(body: unknown): NextRequest {
  const req = new Request('http://localhost:3000/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return req as unknown as NextRequest;
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

const mockWorkflow = { id: VALID_WF_ID, slug: 'test-wf', isActive: true };

const mockScheduleRecord = {
  id: VALID_SCHED_ID,
  workflowId: VALID_WF_ID,
  name: 'Daily run',
  cronExpression: '0 9 * * *',
  inputTemplate: {},
  isEnabled: true,
  lastRunAt: null,
  nextRunAt: new Date('2026-04-19T09:00:00Z'),
  createdBy: 'cmjbv4i3x00003wsloputgwul',
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Schedule CRUD API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── List Schedules ──────────────────────────────────────────────────────

  describe('GET /workflows/:id/schedules', () => {
    it('returns schedules for a valid workflow', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(mockWorkflow as never);
      vi.mocked(prisma.aiWorkflowSchedule.findMany).mockResolvedValue([
        mockScheduleRecord,
      ] as never);

      const res = await listSchedules(makeGetRequest(), {
        params: Promise.resolve({ id: VALID_WF_ID }),
      });
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.schedules).toHaveLength(1);
    });

    it('returns 404 for unknown workflow', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null as never);

      const res = await listSchedules(makeGetRequest(), {
        params: Promise.resolve({ id: VALID_WF_ID }),
      });

      expect(res.status).toBe(404);
    });

    it('rejects unauthenticated requests', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const res = await listSchedules(makeGetRequest(), {
        params: Promise.resolve({ id: VALID_WF_ID }),
      });

      expect(res.status).toBe(401);
    });

    it('rejects invalid workflow ID', async () => {
      const res = await listSchedules(makeGetRequest(), {
        params: Promise.resolve({ id: 'not-a-cuid' }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ── Create Schedule ─────────────────────────────────────────────────────

  describe('POST /workflows/:id/schedules', () => {
    it('creates a schedule with valid data (201)', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(mockWorkflow as never);
      vi.mocked(prisma.aiWorkflowSchedule.create).mockResolvedValue(mockScheduleRecord as never);

      const res = await createSchedule(
        makePostRequest({ name: 'Daily run', cronExpression: '0 9 * * *' }),
        { params: Promise.resolve({ id: VALID_WF_ID }) }
      );
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(201);
      expect(json.data.schedule.name).toBe('Daily run');
    });

    it('rejects invalid cron expression (400)', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(mockWorkflow as never);

      const res = await createSchedule(
        makePostRequest({ name: 'Bad cron', cronExpression: 'nope nope' }),
        { params: Promise.resolve({ id: VALID_WF_ID }) }
      );

      expect(res.status).toBe(400);
    });

    it('returns 404 when workflow does not exist', async () => {
      vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null as never);

      const res = await createSchedule(
        makePostRequest({ name: 'Test', cronExpression: '0 9 * * *' }),
        { params: Promise.resolve({ id: VALID_WF_ID }) }
      );

      expect(res.status).toBe(404);
    });
  });

  // ── Get Single Schedule ─────────────────────────────────────────────────

  describe('GET /workflows/:id/schedules/:scheduleId', () => {
    it('returns the schedule', async () => {
      vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(mockScheduleRecord as never);

      const res = await getSchedule(makeGetRequest(), {
        params: Promise.resolve({ id: VALID_WF_ID, scheduleId: VALID_SCHED_ID }),
      });
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.schedule.id).toBe(VALID_SCHED_ID);
    });

    it('returns 404 when schedule not found', async () => {
      vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(null as never);

      const res = await getSchedule(makeGetRequest(), {
        params: Promise.resolve({ id: VALID_WF_ID, scheduleId: VALID_SCHED_ID }),
      });

      expect(res.status).toBe(404);
    });
  });

  // ── Update Schedule ─────────────────────────────────────────────────────

  describe('PATCH /workflows/:id/schedules/:scheduleId', () => {
    it('updates schedule fields', async () => {
      vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(mockScheduleRecord as never);
      vi.mocked(prisma.aiWorkflowSchedule.update).mockResolvedValue({
        ...mockScheduleRecord,
        name: 'Updated name',
      } as never);

      const res = await updateSchedule(makePatchRequest({ name: 'Updated name' }), {
        params: Promise.resolve({ id: VALID_WF_ID, scheduleId: VALID_SCHED_ID }),
      });
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.schedule.name).toBe('Updated name');
    });

    it('rejects invalid cron on update (400)', async () => {
      vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(mockScheduleRecord as never);

      const res = await updateSchedule(makePatchRequest({ cronExpression: 'bad cron' }), {
        params: Promise.resolve({ id: VALID_WF_ID, scheduleId: VALID_SCHED_ID }),
      });

      expect(res.status).toBe(400);
    });
  });

  // ── Delete Schedule ─────────────────────────────────────────────────────

  describe('DELETE /workflows/:id/schedules/:scheduleId', () => {
    it('deletes the schedule', async () => {
      vi.mocked(prisma.aiWorkflowSchedule.findFirst).mockResolvedValue(mockScheduleRecord as never);
      vi.mocked(prisma.aiWorkflowSchedule.delete).mockResolvedValue(mockScheduleRecord as never);

      const res = await deleteSchedule(makeDeleteRequest(), {
        params: Promise.resolve({ id: VALID_WF_ID, scheduleId: VALID_SCHED_ID }),
      });
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.deleted).toBe(true);
    });
  });

  // ── Scheduler Tick ──────────────────────────────────────────────────────

  describe('POST /schedules/tick', () => {
    it('calls processDueSchedules and returns result', async () => {
      vi.mocked(processDueSchedules).mockResolvedValue({
        processed: 2,
        succeeded: 2,
        failed: 0,
        errors: [],
      });

      const res = await tickScheduler(makePostRequest({}));
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.processed).toBe(2);
      expect(json.data.succeeded).toBe(2);
    });

    it('rejects unauthenticated requests', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const res = await tickScheduler(makePostRequest({}));

      expect(res.status).toBe(401);
    });

    it('returns 429 when rate limited', async () => {
      // Arrange: rate limit exceeded
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await tickScheduler(makePostRequest({}));

      expect(res.status).toBe(429);
      expect(processDueSchedules).not.toHaveBeenCalled();
    });

    it('returns partial results when some schedules fail', async () => {
      // Arrange: 3 processed, 2 succeeded, 1 failed
      vi.mocked(processDueSchedules).mockResolvedValue({
        processed: 3,
        succeeded: 2,
        failed: 1,
        errors: [{ scheduleId: 'sched-1', error: 'Workflow execution failed' }],
      });

      const res = await tickScheduler(makePostRequest({}));
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.processed).toBe(3);
      expect(json.data.failed).toBe(1);
      expect(json.data.errors).toHaveLength(1);
    });

    it('returns zero counts when no schedules are due', async () => {
      // Arrange: nothing to process
      vi.mocked(processDueSchedules).mockResolvedValue({
        processed: 0,
        succeeded: 0,
        failed: 0,
        errors: [],
      });

      const res = await tickScheduler(makePostRequest({}));
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.processed).toBe(0);
    });
  });
});
