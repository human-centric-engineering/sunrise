/**
 * Tests: Event Hook Registry & Dispatcher
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// ─── Module mocks ───────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiEventHook: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ─── Imports ────────────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import {
  emitHookEvent,
  registerInternalHandler,
  invalidateHookCache,
} from '@/lib/orchestration/hooks/registry';

// ─── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  invalidateHookCache();
  mockFetch.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  invalidateHookCache();
});

describe('emitHookEvent', () => {
  it('dispatches webhook hooks matching the event type', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      {
        id: 'hook-1',
        eventType: 'conversation.started',
        action: { type: 'webhook', url: 'https://example.com/hook' },
        filter: null,
        name: 'Test Hook',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    // Allow async dispatch to complete
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          body: expect.stringContaining('"conversation.started"'),
        })
      );
    });
  });

  it('does not dispatch hooks for non-matching event types', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      {
        id: 'hook-1',
        eventType: 'workflow.completed',
        action: { type: 'webhook', url: 'https://example.com/hook' },
        filter: null,
        name: 'Test Hook',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    emitHookEvent('conversation.started', { conversationId: 'conv-1' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalled();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('applies filter to match specific data fields', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      {
        id: 'hook-1',
        eventType: 'message.created',
        action: { type: 'webhook', url: 'https://example.com/hook' },
        filter: { agentSlug: 'support-bot' },
        name: 'Filtered Hook',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    // Should NOT match — wrong agentSlug
    emitHookEvent('message.created', { agentSlug: 'sales-bot' });

    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalled();
    });
    expect(mockFetch).not.toHaveBeenCalled();

    // Should match
    emitHookEvent('message.created', { agentSlug: 'support-bot' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  it('dispatches internal handlers by name', async () => {
    const handler = vi.fn();
    registerInternalHandler('test-handler', handler);

    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      {
        id: 'hook-2',
        eventType: 'workflow.completed',
        action: { type: 'internal', handler: 'test-handler' },
        filter: null,
        name: 'Internal Hook',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    emitHookEvent('workflow.completed', { workflowId: 'wf-1' });

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'workflow.completed',
          data: { workflowId: 'wf-1' },
        })
      );
    });
  });

  it('logs warning when internal handler is not registered', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      {
        id: 'hook-3',
        eventType: 'agent.updated',
        action: { type: 'internal', handler: 'nonexistent' },
        filter: null,
        name: 'Missing Handler Hook',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    emitHookEvent('agent.updated', { agentId: 'agent-1' });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Hook internal handler not found',
        expect.objectContaining({ handler: 'nonexistent' })
      );
    });
  });

  it('logs warning on webhook failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      {
        id: 'hook-4',
        eventType: 'budget.warning',
        action: { type: 'webhook', url: 'https://example.com/fail' },
        filter: null,
        name: 'Failing Hook',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    emitHookEvent('budget.warning', { agentId: 'agent-1' });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(
        'Hook webhook failed',
        expect.objectContaining({ status: 500 })
      );
    });
  });

  it('caches hooks and does not re-query within TTL', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([]);

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(1);
    });

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      // Still only 1 call — cached
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(1);
    });
  });

  it('reloads hooks after invalidateHookCache', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([]);

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(1);
    });

    invalidateHookCache();

    emitHookEvent('conversation.started', {});
    await vi.waitFor(() => {
      expect(prisma.aiEventHook.findMany).toHaveBeenCalledTimes(2);
    });
  });

  it('includes custom headers in webhook requests', async () => {
    vi.mocked(prisma.aiEventHook.findMany).mockResolvedValue([
      {
        id: 'hook-5',
        eventType: 'message.created',
        action: {
          type: 'webhook',
          url: 'https://example.com/hook',
          headers: { Authorization: 'Bearer token123' },
        },
        filter: null,
        name: 'Auth Hook',
        isEnabled: true,
        createdBy: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    emitHookEvent('message.created', { messageId: 'msg-1' });

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'https://example.com/hook',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer token123',
          }),
        })
      );
    });
  });
});
