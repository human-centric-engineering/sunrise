/**
 * Admin Orchestration — Model-level connection test
 *
 * POST /api/v1/admin/orchestration/providers/:id/test-model
 *
 * Sends a trivial prompt to the selected provider + model combination
 * and reports round-trip latency. Returns HTTP 200 with `{ ok, latencyMs }`
 * on success, or `{ ok: false }` when the model fails to respond.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { cuidSchema } from '@/lib/validations/common';

const bodySchema = z.object({
  model: z.string().min(1).max(200),
});

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid provider id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body: unknown = await request.json();
  const bodyResult = bodySchema.safeParse(body);
  if (!bodyResult.success) {
    throw new ValidationError('Invalid request body', {
      model: bodyResult.error.issues.map((i) => i.message),
    });
  }
  const { model } = bodyResult.data;

  const providerRow = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!providerRow) throw new NotFoundError(`Provider ${id} not found`);

  try {
    const provider = await getProvider(providerRow.slug);
    const start = Date.now();
    await provider.chat([{ role: 'user', content: 'Say hello.' }], {
      model,
      maxTokens: 10,
      temperature: 0,
    });
    const latencyMs = Date.now() - start;

    log.info('Model tested', {
      providerId: id,
      slug: providerRow.slug,
      model,
      latencyMs,
      adminId: session.user.id,
    });

    return successResponse({ ok: true, latencyMs, model });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Model test failed', {
      providerId: id,
      slug: providerRow.slug,
      model,
      error: message,
    });
    // The raw SDK error is intentionally NOT forwarded to the client:
    // in a blind-SSRF scenario the verbatim error leaks information
    // about the baseUrl target. Log it server-side, return a generic code.
    return successResponse({ ok: false, latencyMs: null, model, error: 'model_test_failed' });
  }
});
