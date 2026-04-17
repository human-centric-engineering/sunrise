/**
 * Admin Orchestration — Quiz Scores
 *
 * POST /api/v1/admin/orchestration/quiz-scores — save a quiz score
 * GET  /api/v1/admin/orchestration/quiz-scores — list quiz scores for the caller
 *
 * Scores are stored as AiEvaluationSession records with
 * metadata.quizScore = { correct, total }. This reuses the existing
 * evaluation model rather than adding a new table.
 */

import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { saveQuizScoreSchema } from '@/lib/validations/orchestration';

const quizMetadataSchema = z.object({
  quizScore: z.object({ correct: z.number(), total: z.number() }).optional(),
});

const QUIZ_MASTER_SLUG = 'quiz-master';

export const GET = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const sessions = await prisma.aiEvaluationSession.findMany({
    where: {
      userId: session.user.id,
      agent: { slug: QUIZ_MASTER_SLUG },
      metadata: { path: ['quizScore'], not: Prisma.DbNull },
    },
    orderBy: { completedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      metadata: true,
      completedAt: true,
    },
  });

  const scores = sessions.map((s) => {
    const meta = quizMetadataSchema.catch({ quizScore: undefined }).parse(s.metadata);
    return {
      id: s.id,
      correct: meta.quizScore?.correct ?? 0,
      total: meta.quizScore?.total ?? 0,
      completedAt: s.completedAt,
    };
  });

  log.info('Quiz scores listed', { count: scores.length });

  return successResponse(scores);
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { correct, total } = await validateRequestBody(request, saveQuizScoreSchema);

  const agent = await prisma.aiAgent.findUnique({
    where: { slug: QUIZ_MASTER_SLUG },
    select: { id: true },
  });

  const created = await prisma.aiEvaluationSession.create({
    data: {
      userId: session.user.id,
      agentId: agent?.id ?? null,
      title: 'Quiz Score',
      status: 'completed',
      completedAt: new Date(),
      metadata: { quizScore: { correct, total } },
    },
  });

  log.info('Quiz score saved', {
    sessionId: created.id,
    correct,
    total,
    userId: session.user.id,
  });

  return successResponse({ id: created.id, correct, total }, undefined, { status: 201 });
});
