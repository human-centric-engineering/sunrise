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
import { generateSilentWav } from '@/lib/audio/silent-wav';
import { cuidSchema } from '@/lib/validations/common';

// Wider than the matrix `capabilitySchema` (lib/validations/orchestration.ts):
// this route is invoked from the catalogue panel, which renders
// inferred capabilities including `unknown`. Accepting the full
// inference union here lets the route refuse-with-message (see the
// UNSUPPORTED_TEST_MESSAGES block below) instead of 400'ing on
// otherwise valid catalogue rows. Do not unify with the matrix
// schema — they answer different questions.
const capabilitySchema = z.enum([
  'chat',
  'reasoning',
  'embedding',
  'image',
  'audio',
  'moderation',
  'unknown',
]);

const bodySchema = z.object({
  model: z.string().min(1).max(200),
  // Optional for backwards compatibility — pre-Phase B callers (the
  // wizard smoke test, the agent-form test card) only know about
  // chat. Default 'chat' so they keep working unchanged.
  capability: capabilitySchema.optional(),
});

// Friendly per-capability message for the panel's disabled-state
// tooltip. Returned alongside ok: false when the route refuses to
// run a test for an unsupported capability.
const UNSUPPORTED_TEST_MESSAGES: Record<string, string> = {
  reasoning:
    'Reasoning models use the /v1/responses API — testing through this panel is not supported yet.',
  image: "Image generation models can't be tested through this panel.",
  moderation: "Moderation models can't be tested through this panel.",
  unknown: "Unknown model type — we don't have a test surface for this capability.",
};

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
  const { model, capability = 'chat' } = bodyResult.data;

  const providerRow = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!providerRow) throw new NotFoundError(`Provider ${id} not found`);

  // Refuse early for capabilities we can't meaningfully test. No SDK
  // call, no latency measurement — just a structured response so the
  // panel can render a clear "not supported" affordance instead of
  // surfacing a chat 404 / SSRF-shaped error.
  if (capability !== 'chat' && capability !== 'embedding' && capability !== 'audio') {
    log.info('Model test skipped — unsupported capability', {
      providerId: id,
      slug: providerRow.slug,
      model,
      capability,
      adminId: session.user.id,
    });
    return successResponse({
      ok: false,
      latencyMs: null,
      model,
      capability,
      error: 'unsupported_test_capability',
      message: UNSUPPORTED_TEST_MESSAGES[capability] ?? UNSUPPORTED_TEST_MESSAGES.unknown,
    });
  }

  try {
    const provider = await getProvider(providerRow.slug);

    // Audio: providers opt-in via the optional transcribe() interface
    // member. Guard before timing — a missing method is "this provider
    // class doesn't support audio yet", which is configurable state
    // (e.g. seeded a Deepgram row but the Deepgram provider class has
    // no transcribe()). Return a friendly diagnosis instead of letting
    // the call throw a TypeError.
    if (capability === 'audio' && typeof provider.transcribe !== 'function') {
      log.info('Audio model test skipped — provider lacks transcribe()', {
        providerId: id,
        slug: providerRow.slug,
        model,
        adminId: session.user.id,
      });
      return successResponse({
        ok: false,
        latencyMs: null,
        model,
        capability,
        error: 'provider_no_audio_support',
        message:
          'This provider class does not implement audio transcription. Currently supported: OpenAI-API-compatible providers (OpenAI, Groq, Together, Fireworks).',
      });
    }

    const start = Date.now();

    if (capability === 'embedding') {
      // Single-input embedding round-trip. Cheaper than chat and
      // exercises the same auth + base URL surface.
      await provider.embed('hello');
    } else if (capability === 'audio') {
      // Tiny silent WAV — verifies API key, base URL and model id
      // without recording a real clip. Most providers return an
      // empty transcript; the Test button only cares about the
      // round-trip succeeding.
      const wav = generateSilentWav();
      await provider.transcribe!(wav, { model, mimeType: 'audio/wav' });
    } else {
      await provider.chat([{ role: 'user', content: 'Say hello.' }], {
        model,
        maxTokens: 10,
        temperature: 0,
      });
    }
    const latencyMs = Date.now() - start;

    log.info('Model tested', {
      providerId: id,
      slug: providerRow.slug,
      model,
      capability,
      latencyMs,
      adminId: session.user.id,
    });

    return successResponse({ ok: true, latencyMs, model, capability });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Model test failed', {
      providerId: id,
      slug: providerRow.slug,
      model,
      capability,
      error: message,
    });
    // The raw SDK error is intentionally NOT forwarded to the client:
    // in a blind-SSRF scenario the verbatim error leaks information
    // about the baseUrl target. Log it server-side, return a generic code.
    return successResponse({
      ok: false,
      latencyMs: null,
      model,
      capability,
      error: 'model_test_failed',
    });
  }
});
