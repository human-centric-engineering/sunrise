/**
 * Tests for findResumableConversation — resolve a surface's most-recent-active
 * conversation by its `(userId, agentId, contextType, contextId)` tuple.
 *
 * The security-relevant contract is the WHERE clause: the query must always be
 * scoped to `userId` + `agentId` + `isActive`, so a surface can never resume
 * into another user's (or agent's, or archived) conversation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { findFirst: vi.fn() },
  },
}));

const { prisma } = await import('@/lib/db/client');
const { findResumableConversation } = await import('@/lib/orchestration/chat/resume-conversation');

const findFirst = prisma.aiConversation.findFirst as ReturnType<typeof vi.fn>;

const query = {
  userId: 'user-1',
  agentId: 'agent-1',
  contextType: 'module',
  contextId: 'onboarding',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findResumableConversation', () => {
  it('scopes the query to the full tuple + isActive, most-recent first, id only', async () => {
    findFirst.mockResolvedValue({ id: 'conv-9' });

    const id = await findResumableConversation(query);

    expect(id).toBe('conv-9');
    // The scoping IS the contract — assert it exactly so a future refactor
    // can't silently drop `userId`/`agentId`/`isActive` (a cross-user leak).
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        agentId: 'agent-1',
        contextType: 'module',
        contextId: 'onboarding',
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
  });

  it('returns null when no active conversation matches the surface', async () => {
    findFirst.mockResolvedValue(null);

    const id = await findResumableConversation(query);

    expect(id).toBeNull();
  });

  it('returns the id (not the row) so the caller can pass it straight to streamChat', async () => {
    findFirst.mockResolvedValue({ id: 'conv-42' });

    await expect(findResumableConversation(query)).resolves.toBe('conv-42');
  });
});
