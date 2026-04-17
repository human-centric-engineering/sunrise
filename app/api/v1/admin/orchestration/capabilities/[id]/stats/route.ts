/**
 * Admin Orchestration — Capability execution metrics
 *
 * GET /api/v1/admin/orchestration/capabilities/:id/stats
 *
 * Aggregates cost logs and evaluation logs to compute per-capability
 * invocation counts, success rates, latency percentiles, cost, and
 * a daily breakdown over the requested period.
 *
 * Query params:
 *   period — "7d" | "30d" | "90d" (default "30d")
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { cuidSchema } from '@/lib/validations/common';

const querySchema = z.object({
  period: z.enum(['7d', '30d', '90d']).default('30d'),
});

const PERIOD_DAYS: Record<string, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid capability id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  // Verify capability exists and get slug for log queries
  const capability = await prisma.aiCapability.findUnique({
    where: { id },
    select: { id: true, slug: true },
  });
  if (!capability) throw new NotFoundError('Capability not found');

  // Parse period
  const url = new URL(request.url);
  const qResult = querySchema.safeParse({ period: url.searchParams.get('period') ?? undefined });
  if (!qResult.success) {
    throw new ValidationError('Invalid query parameters', { period: ['Must be 7d, 30d, or 90d'] });
  }
  const { period } = qResult.data;
  const days = PERIOD_DAYS[period];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Run queries in parallel
  const [costLogs, evalLogs] = await Promise.all([
    // Cost logs for this capability (operation = tool_call, metadata.slug matches)
    prisma.aiCostLog.findMany({
      where: {
        operation: 'tool_call',
        createdAt: { gte: since },
        metadata: { path: ['slug'], equals: capability.slug },
      },
      select: {
        totalCostUsd: true,
        metadata: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    // Evaluation logs with execution times
    prisma.aiEvaluationLog.findMany({
      where: {
        capabilitySlug: capability.slug,
        eventType: { in: ['capability_call', 'capability_result'] },
        executionTimeMs: { not: null },
        createdAt: { gte: since },
      },
      select: {
        executionTimeMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
  ]);

  // Aggregate cost log metrics
  const invocations = costLogs.length;
  const metaSchema = z.record(z.string(), z.unknown()).nullable().catch(null);
  const successCount = costLogs.filter((log) => {
    const meta = metaSchema.parse(log.metadata);
    return meta?.success === true;
  }).length;
  const successRate = invocations > 0 ? Math.round((successCount / invocations) * 10000) / 100 : 0;
  const totalCostUsd = costLogs.reduce((sum, log) => sum + log.totalCostUsd, 0);

  // Aggregate latency metrics from evaluation logs
  const latencies = evalLogs
    .map((log) => log.executionTimeMs)
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => a - b);

  const avgLatencyMs =
    latencies.length > 0 ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length) : 0;
  const p50LatencyMs = percentile(latencies, 50);
  const p95LatencyMs = percentile(latencies, 95);

  // Daily breakdown from cost logs
  const dailyMap = new Map<string, { invocations: number; successes: number; costUsd: number }>();
  for (const log of costLogs) {
    const day = log.createdAt.toISOString().slice(0, 10);
    const entry = dailyMap.get(day) ?? { invocations: 0, successes: 0, costUsd: 0 };
    entry.invocations += 1;
    const meta = metaSchema.parse(log.metadata);
    if (meta?.success === true) entry.successes += 1;
    entry.costUsd += log.totalCostUsd;
    dailyMap.set(day, entry);
  }

  const dailyBreakdown = Array.from(dailyMap.entries()).map(([date, data]) => ({
    date,
    invocations: data.invocations,
    successRate:
      data.invocations > 0 ? Math.round((data.successes / data.invocations) * 10000) / 100 : 0,
    costUsd: Math.round(data.costUsd * 1000000) / 1000000,
  }));

  return successResponse({
    capabilityId: id,
    capabilitySlug: capability.slug,
    period,
    invocations,
    successRate,
    avgLatencyMs,
    p50LatencyMs,
    p95LatencyMs,
    totalCostUsd: Math.round(totalCostUsd * 1000000) / 1000000,
    dailyBreakdown,
  });
});
