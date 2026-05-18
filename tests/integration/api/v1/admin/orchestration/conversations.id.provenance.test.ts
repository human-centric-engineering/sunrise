/**
 * Integration tests for the conversation provenance routes.
 *
 *  - GET /api/v1/admin/orchestration/conversations/:id/provenance      (JSON)
 *  - GET /api/v1/admin/orchestration/conversations/:id/provenance.md   (Markdown)
 *
 * Both routes share ownership-scoping, rate limit, and validation
 * posture with the existing conversation routes; the JSON variant
 * exposes the typed `MessageProvenance` bundle, the Markdown variant
 * renders it via `renderConversationMarkdown`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { findUnique: vi.fn() },
  },
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { GET as GET_JSON } from '@/app/api/v1/admin/orchestration/conversations/[id]/provenance/route';
import { GET as GET_MD } from '@/app/api/v1/admin/orchestration/conversations/[id]/provenance.md/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
// Matches the user.id returned by `mockAdminUser()` in tests/helpers/auth.ts.
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
const OTHER_USER_ID = 'cmjbv4i3x00003wsloputgwu8';
const INVALID_ID = 'not-a-cuid';

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONV_ID,
    userId: USER_ID,
    agentId: AGENT_ID,
    title: 'Tenancy deposit advice',
    isActive: true,
    createdAt: new Date('2026-05-18T08:00:00Z'),
    updatedAt: new Date('2026-05-18T08:05:00Z'),
    agent: { id: AGENT_ID, slug: 'tenant-advisor', name: 'Tenant Advisor' },
    messages: [],
    ...overrides,
  };
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmjbv4i3x00003wsloputgwu5',
    conversationId: CONV_ID,
    role: 'user',
    content: 'Hello!',
    capabilitySlug: null,
    toolCallId: null,
    metadata: null,
    provenance: null,
    agentVersionId: null,
    workflowExecutionId: null,
    workflowVersionId: null,
    modelId: null,
    providerSlug: null,
    createdAt: new Date('2026-05-18T08:00:00Z'),
    ...overrides,
  };
}

function makeJsonRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/conversations/${CONV_ID}/provenance`
  );
}

function makeMdRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/v1/admin/orchestration/conversations/${CONV_ID}/provenance.md`
  );
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function parseJson<T>(response: Response): Promise<T> {
  return JSON.parse(await response.text()) as T;
}

// ─── Tests: JSON route ────────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/conversations/:id/provenance (JSON)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Authentication & Authorization', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(401);
    });

    it('returns 403 when authenticated as non-admin', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(403);
    });
  });

  describe('Validation', () => {
    it('returns 400 for an invalid id', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      const res = await GET_JSON(makeJsonRequest(), makeParams(INVALID_ID));
      expect(res.status).toBe(400);
    });
  });

  describe('Ownership scoping', () => {
    it('returns 404 when the conversation belongs to another user', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      // Conversation exists but is owned by someone else — must not leak
      // its existence; 404 (not 403) matches the export-route posture.
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ userId: OTHER_USER_ID }) as never
      );
      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(404);
    });

    it('returns 404 when the conversation does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);
      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(404);
    });
  });

  describe('Successful retrieval', () => {
    it('returns the provenance bundle with scalar pins per message', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({
          messages: [
            makeMessage({
              id: 'msg-user',
              role: 'user',
              content: 'Q',
            }),
            makeMessage({
              id: 'msg-assistant',
              role: 'assistant',
              content: 'A [1].',
              modelId: 'claude-sonnet-4-6',
              providerSlug: 'anthropic',
              provenance: {
                citations: [
                  {
                    marker: 1,
                    chunkId: 'c1',
                    documentId: 'd1',
                    documentName: 'Doc',
                    contentHash: 'sha256-xyz',
                    documentVersion: null,
                    section: null,
                    patternNumber: null,
                    patternName: null,
                    excerpt: 'x',
                    similarity: 0.9,
                  },
                ],
              },
            }),
          ],
        }) as never
      );

      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(200);

      const body = await parseJson<{
        success: boolean;
        data: {
          conversation: { id: string; agentSlug: string | null };
          messages: Array<{
            id: string;
            role: string;
            modelId: string | null;
            providerSlug: string | null;
            provenance: { citations?: unknown[] } | null;
          }>;
        };
      }>(res);

      expect(body.success).toBe(true);
      expect(body.data.conversation.agentSlug).toBe('tenant-advisor');
      expect(body.data.messages).toHaveLength(2);

      const assistant = body.data.messages.find((m) => m.role === 'assistant');
      expect(assistant?.modelId).toBe('claude-sonnet-4-6');
      expect(assistant?.providerSlug).toBe('anthropic');
      expect(assistant?.provenance?.citations).toHaveLength(1);
    });

    it('returns null provenance when the persisted JSON fails schema validation', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({
          messages: [
            makeMessage({
              id: 'msg-bad',
              role: 'assistant',
              content: 'Answer.',
              // Citations missing required fields — bundle is malformed.
              provenance: { citations: [{ marker: 'one' }] },
            }),
          ],
        }) as never
      );

      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(200);
      const body = await parseJson<{ data: { messages: Array<{ provenance: unknown }> } }>(res);
      // Malformed → null, not a 500. Caller's UI degrades gracefully.
      expect(body.data.messages[0]?.provenance).toBeNull();
    });
  });
});

// ─── Tests: Markdown route ────────────────────────────────────────────────────

describe('GET /api/v1/admin/orchestration/conversations/:id/provenance.md', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockUnauthenticatedUser());
    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(res.status).toBe(401);
  });

  it('returns 403 when authenticated as non-admin', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(res.status).toBe(403);
  });

  it('returns 400 for an invalid id', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    const res = await GET_MD(makeMdRequest(), makeParams(INVALID_ID));
    expect(res.status).toBe(400);
  });

  it('returns 404 when conversation belongs to another user', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
      makeConversation({ userId: OTHER_USER_ID }) as never
    );
    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(res.status).toBe(404);
  });

  it('returns text/markdown with attachment disposition and a no-store cache directive', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
      makeConversation({
        messages: [
          makeMessage({
            id: 'msg-assistant',
            role: 'assistant',
            content: 'A.',
            modelId: 'claude-sonnet-4-6',
          }),
        ],
      }) as never
    );

    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/markdown');
    expect(res.headers.get('Content-Disposition')).toContain(
      `conversation-${CONV_ID}-provenance.md`
    );
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const body = await res.text();
    expect(body).toContain(`# Conversation provenance — \`${CONV_ID}\``);
    expect(body).toContain('Tenant Advisor');
    expect(body).toContain('Model `claude-sonnet-4-6`');
  });
});
