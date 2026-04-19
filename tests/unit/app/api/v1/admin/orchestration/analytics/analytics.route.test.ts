/**
 * Unit Test: Analytics API endpoints
 *
 * Covers:
 * - GET /analytics/topics — popular topics
 * - GET /analytics/unanswered — unanswered questions
 * - GET /analytics/engagement — engagement metrics
 * - GET /analytics/content-gaps — content gaps
 *
 * Each endpoint follows the same pattern (admin auth + rate limit +
 * query params → service call → successResponse), so we test auth
 * and query parsing thoroughly on /topics and verify the others work.
 *
 * @see app/api/v1/admin/orchestration/analytics/
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

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({
  getClientIP: vi.fn(() => '127.0.0.1'),
}));

vi.mock('@/lib/orchestration/analytics', () => ({
  getPopularTopics: vi.fn(),
  getUnansweredQuestions: vi.fn(),
  getEngagementMetrics: vi.fn(),
  getContentGaps: vi.fn(),
  getFeedbackSummary: vi.fn(),
}));

// ─── Imports ────────────────────────────────────────────────────────────────

import { GET as getTopics } from '@/app/api/v1/admin/orchestration/analytics/topics/route';
import { GET as getUnanswered } from '@/app/api/v1/admin/orchestration/analytics/unanswered/route';
import { GET as getEngagement } from '@/app/api/v1/admin/orchestration/analytics/engagement/route';
import { GET as getGaps } from '@/app/api/v1/admin/orchestration/analytics/content-gaps/route';
import { GET as getFeedback } from '@/app/api/v1/admin/orchestration/analytics/feedback/route';
import { auth } from '@/lib/auth/config';
import { adminLimiter } from '@/lib/security/rate-limit';
import {
  getPopularTopics,
  getUnansweredQuestions,
  getEngagementMetrics,
  getContentGaps,
  getFeedbackSummary,
} from '@/lib/orchestration/analytics';
import { mockAdminUser, mockUnauthenticatedUser } from '@/tests/helpers/auth';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGetRequest(queryString = ''): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(),
    url: `http://localhost:3000/api/v1/admin/orchestration/analytics/topics${queryString}`,
  } as unknown as NextRequest;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Analytics API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  // ── Topics Endpoint ─────────────────────────────────────────────────────

  describe('GET /analytics/topics', () => {
    it('returns topics with default query params', async () => {
      vi.mocked(getPopularTopics).mockResolvedValue([
        { content: 'Hello', count: 5, lastAsked: new Date() },
      ]);

      const res = await getTopics(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.topics).toHaveLength(1);
      expect(json.data.topics[0].content).toBe('Hello');
    });

    it('passes query params to service', async () => {
      vi.mocked(getPopularTopics).mockResolvedValue([]);

      await getTopics(makeGetRequest('?from=2026-04-01T00:00:00Z&to=2026-04-19T00:00:00Z&limit=5'));

      expect(getPopularTopics).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '2026-04-01T00:00:00Z',
          to: '2026-04-19T00:00:00Z',
          limit: 5,
        })
      );
    });

    it('rejects unauthenticated requests (401)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const res = await getTopics(makeGetRequest());

      expect(res.status).toBe(401);
    });

    it('returns 429 when rate limited', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await getTopics(makeGetRequest());

      expect(res.status).toBe(429);
    });
  });

  // ── Unanswered Endpoint ─────────────────────────────────────────────────

  describe('GET /analytics/unanswered', () => {
    it('returns unanswered questions', async () => {
      vi.mocked(getUnansweredQuestions).mockResolvedValue([
        {
          conversationId: 'conv_1',
          agentId: 'agent_1',
          userMessage: 'What is X?',
          assistantReply: "I don't know",
          createdAt: new Date(),
        },
      ]);

      const res = await getUnanswered(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.questions).toHaveLength(1);
    });

    it('rejects unauthenticated requests', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const res = await getUnanswered(makeGetRequest());

      expect(res.status).toBe(401);
    });

    it('returns 429 when rate limited', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await getUnanswered(makeGetRequest());

      expect(res.status).toBe(429);
    });
  });

  // ── Engagement Endpoint ─────────────────────────────────────────────────

  describe('GET /analytics/engagement', () => {
    it('returns engagement metrics', async () => {
      vi.mocked(getEngagementMetrics).mockResolvedValue({
        totalConversations: 10,
        totalMessages: 50,
        uniqueUsers: 5,
        avgMessagesPerConversation: 5,
        returningUsers: 2,
        returningUserRate: 0.4,
        conversationsByDay: [{ date: '2026-04-15', count: 3 }],
      });

      const res = await getEngagement(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.metrics.totalConversations).toBe(10);
      expect(json.data.metrics.uniqueUsers).toBe(5);
    });
  });

  // ── Content Gaps Endpoint ───────────────────────────────────────────────

  describe('GET /analytics/content-gaps', () => {
    it('returns content gaps', async () => {
      vi.mocked(getContentGaps).mockResolvedValue([
        { topic: 'Refunds', queryCount: 10, unansweredCount: 7, gapRatio: 0.7 },
      ]);

      const res = await getGaps(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.gaps).toHaveLength(1);
      expect(json.data.gaps[0].topic).toBe('Refunds');
      expect(json.data.gaps[0].gapRatio).toBe(0.7);
    });

    it('returns empty array when no content gaps', async () => {
      // Arrange: all topics answered well
      vi.mocked(getContentGaps).mockResolvedValue([]);

      const res = await getGaps(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.gaps).toHaveLength(0);
    });

    it('rejects unauthenticated requests', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const res = await getGaps(makeGetRequest());

      expect(res.status).toBe(401);
    });

    it('returns 429 when rate limited', async () => {
      vi.mocked(adminLimiter.check).mockReturnValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now() + 60_000,
      } as never);

      const res = await getGaps(makeGetRequest());

      expect(res.status).toBe(429);
    });

    it('passes agentId query param to service', async () => {
      vi.mocked(getContentGaps).mockResolvedValue([]);

      await getGaps(makeGetRequest('?agentId=cmjbv4i3x00003wsloputgwu2'));

      expect(getContentGaps).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: 'cmjbv4i3x00003wsloputgwu2' })
      );
    });
  });

  // ── Feedback Summary Endpoint ───────────────────────────────────────────

  describe('GET /analytics/feedback', () => {
    it('returns feedback summary', async () => {
      vi.mocked(getFeedbackSummary).mockResolvedValue({
        overall: { thumbsUp: 8, thumbsDown: 2, total: 10, satisfactionRate: 0.8 },
        byAgent: [
          {
            agentId: 'a1',
            agentName: 'Agent One',
            thumbsUp: 8,
            thumbsDown: 2,
            total: 10,
            satisfactionRate: 0.8,
          },
        ],
        recentNegative: [],
      });

      const res = await getFeedback(makeGetRequest());
      const json = JSON.parse(await res.text());

      expect(res.status).toBe(200);
      expect(json.data.feedback.overall.satisfactionRate).toBe(0.8);
      expect(json.data.feedback.byAgent).toHaveLength(1);
    });
  });
});
