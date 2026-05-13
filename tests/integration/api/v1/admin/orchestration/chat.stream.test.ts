/**
 * Integration Test: Admin Orchestration — Streaming Chat SSE
 *
 * POST /api/v1/admin/orchestration/chat/stream
 *
 * @see app/api/v1/admin/orchestration/chat/stream/route.ts
 *
 * Key security assertions:
 * - Admin auth required (401/403 otherwise)
 * - Rate limited (adminLimiter)
 * - SSE bridge never leaks raw error messages to the client
 * - If the upstream streamChat iterable throws with a secret value,
 *   the wire output contains only the sanitized terminal frame.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/v1/admin/orchestration/chat/stream/route';
import {
  mockAdminUser,
  mockAuthenticatedUser,
  mockUnauthenticatedUser,
} from '@/tests/helpers/auth';

// ─── Mock dependencies ───────────────────────────────────────────────────────

vi.mock('@/lib/auth/config', () => ({
  auth: { api: { getSession: vi.fn() } },
}));

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(new Headers())),
}));

vi.mock('@/lib/orchestration/chat', () => ({
  streamChat: vi.fn(),
}));

vi.mock('@/lib/security/rate-limit', () => ({
  adminLimiter: { check: vi.fn(() => ({ success: true })) },
  chatLimiter: { check: vi.fn(() => ({ success: true })) },
  createRateLimitResponse: vi.fn(() =>
    Response.json({ success: false, error: { code: 'RATE_LIMITED' } }, { status: 429 })
  ),
}));

vi.mock('@/lib/security/ip', () => ({ getClientIP: vi.fn(() => '127.0.0.1') }));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { streamChat } from '@/lib/orchestration/chat';
import { adminLimiter } from '@/lib/security/rate-limit';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePostRequest(body: Record<string, unknown>): NextRequest {
  return {
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: () => Promise.resolve(body),
    signal: new AbortController().signal,
    url: 'http://localhost:3000/api/v1/admin/orchestration/chat/stream',
  } as unknown as NextRequest;
}

async function* makeStreamEvents<T>(events: T[]): AsyncIterable<T> {
  for (const e of events) {
    yield e;
  }
}

async function readAllSse(body: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value));
  }
  return chunks.join('');
}

const VALID_BODY = {
  message: 'Hello, agent!',
  agentSlug: 'test-agent',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/admin/orchestration/chat/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(adminLimiter.check).mockReturnValue({ success: true } as never);
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(403);
    });
  });

  describe('Successful streaming', () => {
    it('returns 200 with text/event-stream content type', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(
        makeStreamEvents([
          { type: 'start', conversationId: 'c1', messageId: 'm1' },
          { type: 'content', delta: 'Hello' },
          { type: 'content', delta: ' world' },
          { type: 'done', tokenUsage: { input: 10, output: 5 }, costUsd: 0.01 },
        ]) as never
      );

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    });

    it('emits start, content, and done frames in order', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(
        makeStreamEvents([
          { type: 'start', conversationId: 'c1', messageId: 'm1' },
          { type: 'content', delta: 'Hello' },
          { type: 'content', delta: ' world' },
          { type: 'done', tokenUsage: { input: 10, output: 5 }, costUsd: 0.01 },
        ]) as never
      );

      const response = await POST(makePostRequest(VALID_BODY));
      const body = await readAllSse(response.body);

      // Check for event frames in order
      const startPos = body.indexOf('event: start');
      const contentPos = body.indexOf('event: content');
      const donePos = body.indexOf('event: done');

      expect(startPos).toBeGreaterThanOrEqual(0);
      expect(contentPos).toBeGreaterThan(startPos);
      expect(donePos).toBeGreaterThan(contentPos);

      expect(body).toContain('"conversationId":"c1"');
      expect(body).toContain('"messageId":"m1"');
      expect(body).toContain('"delta":"Hello"');
      expect(body).toContain('"costUsd":0.01');
    });

    it('passes userId from session to streamChat', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(makeStreamEvents([{ type: 'done' }]) as never);

      await POST(makePostRequest(VALID_BODY));
      await new Promise((r) => setTimeout(r, 0)); // let stream drain

      expect(vi.mocked(streamChat)).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'cmjbv4i3x00003wsloputgwul' })
      );
    });

    it('passes optional conversationId when supplied', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(makeStreamEvents([{ type: 'done' }]) as never);

      await POST(makePostRequest({ ...VALID_BODY, conversationId: 'cmjbv4i3x00003wsloputgwul' }));

      expect(vi.mocked(streamChat)).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'cmjbv4i3x00003wsloputgwul' })
      );
    });

    it('forwards includeTrace: true into streamChat when admin client opts in', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(makeStreamEvents([{ type: 'done' }]) as never);

      await POST(makePostRequest({ ...VALID_BODY, includeTrace: true }));

      expect(vi.mocked(streamChat)).toHaveBeenCalledWith(
        expect.objectContaining({ includeTrace: true })
      );
    });

    it('defaults includeTrace to false when the admin client omits it', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(makeStreamEvents([{ type: 'done' }]) as never);

      await POST(makePostRequest(VALID_BODY));

      expect(vi.mocked(streamChat)).toHaveBeenCalledWith(
        expect.objectContaining({ includeTrace: false })
      );
    });
  });

  describe('Validation errors', () => {
    it('returns 400 when message is empty string', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ ...VALID_BODY, message: '' }));

      expect(response.status).toBe(400);
      const data = JSON.parse(await response.text()) as {
        success: boolean;
        error: { code: string };
      };
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when agentSlug is missing', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({ message: 'Hello' }));

      expect(response.status).toBe(400);
    });

    it('returns 400 when body is empty object', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      const response = await POST(makePostRequest({}));

      expect(response.status).toBe(400);
    });
  });

  describe('SSE sanitization regression', () => {
    it('forwards sanitized error event from upstream handler without leaking internal message', async () => {
      // The streaming handler already sanitizes errors before yielding them.
      // This test verifies that a sanitized error event shape passes through
      // the SSE bridge correctly and does NOT contain any raw leak string.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(
        makeStreamEvents([
          { type: 'start', conversationId: 'c1', messageId: 'm1' },
          { type: 'error', code: 'internal_error', message: 'An unexpected error occurred' },
        ]) as never
      );

      const response = await POST(makePostRequest(VALID_BODY));
      const body = await readAllSse(response.body);

      expect(body).toContain('event: error');
      expect(body).toContain('An unexpected error occurred');
      // Verify no raw internal leak string appears in the wire output
      expect(body).not.toContain('SECRET_PROD_HOSTNAME');
    });

    it('emits sanitized terminal frame and NO raw leak when iterable throws mid-stream', async () => {
      // If the mocked streamChat iterable throws mid-iteration, the SSE bridge
      // must catch it and emit only the generic terminal error frame.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());

      async function* throwingIterable() {
        yield { type: 'start', conversationId: 'c1', messageId: 'm1' };
        throw new Error('SECRET_PROD_HOSTNAME internal details here');
      }

      vi.mocked(streamChat).mockReturnValue(throwingIterable() as never);

      const response = await POST(makePostRequest(VALID_BODY));
      const body = await readAllSse(response.body);

      expect(body).toContain('event: start');
      // Bridge emits generic terminal frame
      expect(body).toContain('event: error');
      expect(body).toContain('Stream terminated unexpectedly');
      // Critically: the raw error message must NOT appear on the wire
      expect(body).not.toContain('SECRET_PROD_HOSTNAME');
      expect(body).not.toContain('internal details here');
    });
  });

  describe('Rate limiting', () => {
    it('calls adminLimiter.check on POST', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(streamChat).mockReturnValue(makeStreamEvents([{ type: 'done' }]) as never);

      await POST(makePostRequest(VALID_BODY));

      expect(vi.mocked(adminLimiter.check)).toHaveBeenCalledOnce();
    });

    it('returns 429 when rate limit exceeded', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminLimiter.check).mockReturnValue({ success: false } as never);

      const response = await POST(makePostRequest(VALID_BODY));

      expect(response.status).toBe(429);
      // streamChat was never called because the guard short-circuits
      expect(vi.mocked(streamChat)).not.toHaveBeenCalled();
    });
  });
});
