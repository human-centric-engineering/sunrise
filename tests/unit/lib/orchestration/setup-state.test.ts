/**
 * Unit Tests: lib/orchestration/setup-state
 *
 * Test Coverage:
 * - getSetupState: empty DB → hasProvider false, hasAgent false, hasDefaultChatModel false
 * - getSetupState: providers + agents present → hasProvider/hasAgent true
 * - getSetupState: defaultModels.chat populated → hasDefaultChatModel true
 * - getSetupState: defaultModels.chat empty string → hasDefaultChatModel false
 * - getSetupState: DB throws → falls back to "everything-set-up" so the
 *   wizard banner doesn't pop up on a transient blip
 *
 * @see lib/orchestration/setup-state.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiProviderConfig: { count: vi.fn() },
    aiAgent: { count: vi.fn() },
    aiOrchestrationSettings: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/orchestration/settings', () => ({
  parseStoredDefaults: vi.fn((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return {};
    return raw as Record<string, string>;
  }),
}));

vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

// ─── Imports after mocks ──────────────────────────────────────────────────────

import { prisma } from '@/lib/db/client';
import { getSetupState } from '@/lib/orchestration/setup-state';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getSetupState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a fully empty state on a fresh install', async () => {
    vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    const state = await getSetupState();

    expect(state).toEqual({
      hasProvider: false,
      hasAgent: false,
      hasDefaultChatModel: false,
    });
  });

  it('reports hasProvider/hasAgent true when rows exist', async () => {
    vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(2);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(5);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    const state = await getSetupState();

    expect(state.hasProvider).toBe(true);
    expect(state.hasAgent).toBe(true);
    expect(state.hasDefaultChatModel).toBe(false);
  });

  it('excludes system-seeded agents from the hasAgent count', async () => {
    // The hasAgent contract documents "Excludes system seeds" — the
    // source filters via `where: { isSystem: false }` so seeded agents
    // (pattern-advisor, quiz-master, mcp-system, model-auditor) don't
    // suppress the setup-required banner on a fresh install. Without
    // this assertion the filter could be removed and every test would
    // still pass because mockResolvedValue ignores arguments.
    vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(1);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    await getSetupState();

    expect(prisma.aiAgent.count).toHaveBeenCalledWith({ where: { isSystem: false } });
  });

  it('reports hasDefaultChatModel true when defaultModels.chat is set', async () => {
    vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(1);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      slug: 'global',
      defaultModels: { chat: 'claude-sonnet-4-6' },
    } as never);

    const state = await getSetupState();

    expect(state.hasDefaultChatModel).toBe(true);
  });

  it('reports hasDefaultChatModel false when defaultModels.chat is the empty string', async () => {
    vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(1);
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue({
      slug: 'global',
      defaultModels: { chat: '' },
    } as never);

    const state = await getSetupState();

    expect(state.hasDefaultChatModel).toBe(false);
  });

  it('falls back to "everything-set-up" on DB failure', async () => {
    vi.mocked(prisma.aiProviderConfig.count).mockRejectedValue(new Error('connection lost'));
    vi.mocked(prisma.aiAgent.count).mockResolvedValue(0);
    vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

    const state = await getSetupState();

    // Probe failures must not pop the wizard banner — the orchestration
    // dashboard already loads a half-dozen async sources and any of
    // them can fail transiently.
    expect(state).toEqual({
      hasProvider: true,
      hasAgent: true,
      hasDefaultChatModel: true,
    });
  });
});
