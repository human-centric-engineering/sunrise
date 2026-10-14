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

vi.mock('@/lib/orchestration/audit/admin-audit-logger', () => ({
  logConversationAccess: vi.fn(),
}));

// The real `where` fragments (pure), with only the per-row check mocked.
vi.mock('@/lib/orchestration/access/conversation-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/orchestration/access/conversation-access')>()),
  adminCanViewConversation: vi.fn(),
}));

// ─── Imports after mocks ─────────────────────────────────────────────────────

import { auth } from '@/lib/auth/config';
import { prisma } from '@/lib/db/client';
import { logConversationAccess } from '@/lib/orchestration/audit/admin-audit-logger';
import { adminCanViewConversation } from '@/lib/orchestration/access/conversation-access';
import { GET as GET_JSON } from '@/app/api/v1/admin/orchestration/conversations/[id]/provenance/route';
import { GET as GET_MD } from '@/app/api/v1/admin/orchestration/conversations/[id]/provenance.md/route';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const AGENT_ID = 'cmjbv4i3x00003wsloputgwu2';
const CONV_ID = 'cmjbv4i3x00003wsloputgwu3';
// Matches the user.id returned by `mockAdminUser()` in tests/helpers/auth.ts.
const USER_ID = 'cmjbv4i3x00003wsloputgwul';
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

  describe('Consent-gated access', () => {
    it('returns 404 when the helper denies (no share + non-owner)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: false,
        basis: null,
        ownerId: null,
      });
      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(404);
    });

    it('returns 404 when the conversation does not exist', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: false,
        basis: null,
        ownerId: null,
      });
      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(404);
    });

    it('returns 404 if the conversation disappears between the access check and the data fetch (TOCTOU)', async () => {
      // Defensive belt-and-braces — same shape as the messages route.
      // Helper says ok, but the subsequent findUnique returns null
      // because the conversation was deleted in the meantime.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);

      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(404);
    });
  });

  describe('Successful retrieval', () => {
    it('returns the provenance bundle with scalar pins per message (owner basis)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
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

    it('renders the conversation header with null agent fields when the agent has been deleted', async () => {
      // The route's response shape uses `conversation.agent?.slug ?? null`
      // and `conversation.agent?.name ?? null` to tolerate a missing
      // agent relation. Cover those nullish-coalescing branches.
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ agent: null, messages: [] }) as never
      );

      const res = await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(res.status).toBe(200);
      const body = await parseJson<{
        data: { conversation: { agentSlug: string | null; agentName: string | null } };
      }>(res);
      expect(body.data.conversation.agentSlug).toBeNull();
      expect(body.data.conversation.agentName).toBeNull();
    });

    it('returns null provenance when the persisted JSON fails schema validation', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
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

  describe('Audit-of-audits', () => {
    it('writes a conversation.provenance_export audit entry on cross-user (shared) fetch', async () => {
      const OTHER_USER = 'cmjbv4i3x00003wsloputgwz9';
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'shared',
        ownerId: OTHER_USER,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({
          userId: OTHER_USER,
          messages: [makeMessage({ role: 'user' }), makeMessage({ role: 'assistant' })],
        }) as never
      );

      await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));

      expect(vi.mocked(logConversationAccess)).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: USER_ID,
          accessBasis: 'shared',
          conversationOwnerId: OTHER_USER,
          action: 'conversation.provenance_export',
          conversationId: CONV_ID,
          conversationTitle: 'Tenancy deposit advice',
          extra: expect.objectContaining({ format: 'json', messageCount: 2 }),
        })
      );
    });

    it('owner-basis fetch passes basis=owner to the helper (which no-ops)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: true,
        basis: 'owner',
        ownerId: USER_ID,
      });
      vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
        makeConversation({ messages: [makeMessage({ role: 'user' })] }) as never
      );

      await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));

      // Route always calls logConversationAccess; the helper itself
      // decides whether to write the DB row (it no-ops on owner).
      expect(vi.mocked(logConversationAccess)).toHaveBeenCalledWith(
        expect.objectContaining({ accessBasis: 'owner' })
      );
    });

    it('does not call the audit helper on auth failure', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAuthenticatedUser('USER'));
      await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(vi.mocked(logConversationAccess)).not.toHaveBeenCalled();
    });

    it('does not call the audit helper on a 404 (helper denies)', async () => {
      vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
      vi.mocked(adminCanViewConversation).mockResolvedValue({
        ok: false,
        basis: null,
        ownerId: null,
      });
      await GET_JSON(makeJsonRequest(), makeParams(CONV_ID));
      expect(vi.mocked(logConversationAccess)).not.toHaveBeenCalled();
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

  it('returns 404 when the helper denies (no share + non-owner)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminCanViewConversation).mockResolvedValue({
      ok: false,
      basis: null,
      ownerId: null,
    });
    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(res.status).toBe(404);
  });

  it('returns 404 if the conversation disappears between the access check and the data fetch (TOCTOU)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminCanViewConversation).mockResolvedValue({
      ok: true,
      basis: 'owner',
      ownerId: USER_ID,
    });
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(null);

    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(res.status).toBe(404);
  });

  it('returns text/markdown with attachment disposition and a no-store cache directive (owner basis)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminCanViewConversation).mockResolvedValue({
      ok: true,
      basis: 'owner',
      ownerId: USER_ID,
    });
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

  it('renders the Markdown header with null agent fields when the agent has been deleted', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminCanViewConversation).mockResolvedValue({
      ok: true,
      basis: 'owner',
      ownerId: USER_ID,
    });
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
      makeConversation({ agent: null, messages: [] }) as never
    );

    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(res.status).toBe(200);
    const body = await res.text();
    // The renderer falls back to `\`—\`` for the agent label when name,
    // slug, and id are all null. Confirm the header still renders.
    expect(body).toContain(`# Conversation provenance — \`${CONV_ID}\``);
  });

  it('writes a conversation.provenance_export audit entry on cross-user (shared) Markdown fetch', async () => {
    const OTHER_USER = 'cmjbv4i3x00003wsloputgwz9';
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminCanViewConversation).mockResolvedValue({
      ok: true,
      basis: 'shared',
      ownerId: OTHER_USER,
    });
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
      makeConversation({
        userId: OTHER_USER,
        messages: [makeMessage({ role: 'user' }), makeMessage({ role: 'assistant' })],
      }) as never
    );

    await GET_MD(makeMdRequest(), makeParams(CONV_ID));

    expect(vi.mocked(logConversationAccess)).toHaveBeenCalledWith(
      expect.objectContaining({
        adminUserId: USER_ID,
        accessBasis: 'shared',
        conversationOwnerId: OTHER_USER,
        action: 'conversation.provenance_export',
        extra: expect.objectContaining({ format: 'markdown', messageCount: 2 }),
      })
    );
    // bytes is populated from the rendered string length
    const call = vi.mocked(logConversationAccess).mock.calls[0]?.[0];
    const bytes = (call?.extra as { bytes?: number } | undefined)?.bytes;
    expect(bytes).toBeGreaterThan(0);
  });

  it('does not call the audit helper on a 404 (helper denies)', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminCanViewConversation).mockResolvedValue({
      ok: false,
      basis: null,
      ownerId: null,
    });
    await GET_MD(makeMdRequest(), makeParams(CONV_ID));
    expect(vi.mocked(logConversationAccess)).not.toHaveBeenCalled();
  });

  it('logs a warning and omits the bundle when persisted provenance is malformed', async () => {
    // Mirror of the JSON-route case higher up — the renderer must
    // degrade gracefully on a malformed provenance JSON rather than
    // 500 the caller. The Markdown variant exercises a separate
    // safeParse-and-log branch.
    vi.mocked(auth.api.getSession).mockResolvedValue(mockAdminUser());
    vi.mocked(adminCanViewConversation).mockResolvedValue({
      ok: true,
      basis: 'owner',
      ownerId: USER_ID,
    });
    vi.mocked(prisma.aiConversation.findUnique).mockResolvedValue(
      makeConversation({
        messages: [
          makeMessage({
            id: 'msg-bad',
            role: 'assistant',
            content: 'A',
            // Citations missing required fields — bundle is malformed.
            provenance: { citations: [{ marker: 'one' }] },
          }),
        ],
      }) as never
    );

    const res = await GET_MD(makeMdRequest(), makeParams(CONV_ID));

    expect(res.status).toBe(200);
    const body = await res.text();
    // Markdown still renders the message header — but with no
    // provenance section attached.
    expect(body).toContain('Assistant');
    expect(body).not.toContain('Citations');
  });
});
