/**
 * payload-context tests
 *
 * Helpers that resolve display names for webhook payloads. Contract:
 *   - null/undefined id → empty result (no DB call)
 *   - found → name + slug as returned
 *   - missing row → empty result
 *   - DB throws → swallowed, empty result (never blocks dispatch)
 *
 * @see lib/orchestration/webhooks/payload-context.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Prisma client BEFORE importing the module under test so the
// import resolves the mock.
vi.mock('@/lib/db/client', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    aiWorkflow: { findUnique: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

import { prisma } from '@/lib/db/client';
import {
  resolveUserDisplayName,
  resolveWorkflowDisplay,
  resolveAgentDisplay,
} from '@/lib/orchestration/webhooks/payload-context';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── resolveUserDisplayName ──────────────────────────────────────────────────

describe('resolveUserDisplayName', () => {
  it('returns undefined when userId is null without touching the DB', async () => {
    const result = await resolveUserDisplayName(null);
    expect(result).toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns undefined when userId is undefined without touching the DB', async () => {
    const result = await resolveUserDisplayName(undefined);
    expect(result).toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns undefined for an empty-string userId without touching the DB', async () => {
    const result = await resolveUserDisplayName('');
    expect(result).toBeUndefined();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns the user name when the row exists', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ name: 'Alice Admin' } as never);
    const result = await resolveUserDisplayName('u_1');
    expect(result).toBe('Alice Admin');
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'u_1' },
      select: { name: true },
    });
  });

  it('returns undefined when the row exists but name is null', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ name: null } as never);
    expect(await resolveUserDisplayName('u_2')).toBeUndefined();
  });

  it('returns undefined when the row is not found', async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null as never);
    expect(await resolveUserDisplayName('u_missing')).toBeUndefined();
  });

  it('swallows DB errors and returns undefined', async () => {
    vi.mocked(prisma.user.findUnique).mockRejectedValue(new Error('DB offline'));
    expect(await resolveUserDisplayName('u_explodes')).toBeUndefined();
  });
});

// ─── resolveWorkflowDisplay ──────────────────────────────────────────────────

describe('resolveWorkflowDisplay', () => {
  it('returns an empty object when workflowId is null without touching the DB', async () => {
    const result = await resolveWorkflowDisplay(null);
    expect(result).toEqual({});
    expect(prisma.aiWorkflow.findUnique).not.toHaveBeenCalled();
  });

  it('returns an empty object when workflowId is undefined without touching the DB', async () => {
    const result = await resolveWorkflowDisplay(undefined);
    expect(result).toEqual({});
    expect(prisma.aiWorkflow.findUnique).not.toHaveBeenCalled();
  });

  it('returns slug + name when the workflow row exists', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue({
      slug: 'crash-flow-wf',
      name: 'Crash Flow',
    } as never);

    const result = await resolveWorkflowDisplay('wf_1');
    expect(result).toEqual({ slug: 'crash-flow-wf', name: 'Crash Flow' });
    expect(prisma.aiWorkflow.findUnique).toHaveBeenCalledWith({
      where: { id: 'wf_1' },
      select: { slug: true, name: true },
    });
  });

  it('returns an empty object when the row is not found', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockResolvedValue(null as never);
    expect(await resolveWorkflowDisplay('wf_missing')).toEqual({});
  });

  it('swallows DB errors and returns an empty object', async () => {
    vi.mocked(prisma.aiWorkflow.findUnique).mockRejectedValue(new Error('DB offline'));
    expect(await resolveWorkflowDisplay('wf_explodes')).toEqual({});
  });
});

// ─── resolveAgentDisplay ─────────────────────────────────────────────────────

describe('resolveAgentDisplay', () => {
  it('returns an empty object when agentId is null without touching the DB', async () => {
    const result = await resolveAgentDisplay(null);
    expect(result).toEqual({});
    expect(prisma.aiAgent.findUnique).not.toHaveBeenCalled();
  });

  it('returns an empty object when agentId is undefined without touching the DB', async () => {
    const result = await resolveAgentDisplay(undefined);
    expect(result).toEqual({});
    expect(prisma.aiAgent.findUnique).not.toHaveBeenCalled();
  });

  it('returns slug + name when the agent row exists', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue({
      slug: 'support-bot',
      name: 'Support Bot',
    } as never);

    const result = await resolveAgentDisplay('agent_1');
    expect(result).toEqual({ slug: 'support-bot', name: 'Support Bot' });
    expect(prisma.aiAgent.findUnique).toHaveBeenCalledWith({
      where: { id: 'agent_1' },
      select: { slug: true, name: true },
    });
  });

  it('returns an empty object when the row is not found', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockResolvedValue(null as never);
    expect(await resolveAgentDisplay('agent_missing')).toEqual({});
  });

  it('swallows DB errors and returns an empty object', async () => {
    vi.mocked(prisma.aiAgent.findUnique).mockRejectedValue(new Error('DB offline'));
    expect(await resolveAgentDisplay('agent_explodes')).toEqual({});
  });
});
