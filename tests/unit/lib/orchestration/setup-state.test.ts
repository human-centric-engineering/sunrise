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
 * - getSetupState at TENANCY_MODE=multi (#1295): the agent count runs in the
 *   org the viewer entered, so the data layer's no-context refusal no longer
 *   reads as "set up"; with no org entered, hasAgent cannot be asked and
 *   answers true while the platform-wide probes still answer truthfully
 *
 * @see lib/orchestration/setup-state.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockEnv = vi.hoisted(() => ({ TENANCY_MODE: 'single' }));
vi.mock('@/lib/env', () => ({ env: mockEnv }));

vi.mock('@/lib/auth/admin-page-viewer', () => ({
  requestPrincipal: vi.fn(),
}));

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
import { requestPrincipal } from '@/lib/auth/admin-page-viewer';
import { getSetupState } from '@/lib/orchestration/setup-state';
import { getTenantContext } from '@/lib/tenancy/context';

type Entry = Awaited<ReturnType<typeof requestPrincipal>>;

/** The viewer's session principal, as `requestPrincipal()` builds it for an entered org. */
function enteredOrg(orgId: string): Entry {
  return {
    principal: { userId: 'user_1', role: 'ADMIN', credential: 'session', orgId, orgRole: 'OWNER' },
    scope: { org: orgId },
  };
}

/**
 * The data layer's rule at multi for a tenant-owned model (lib/db/tenancy-extension.ts):
 * no tenant context, refuse. `AiAgent` is tenant-owned; the provider and settings
 * models are global config (lib/tenancy/classification.ts) and need no context.
 */
function agentCountRefusingWithoutOrg(count: number) {
  return () => {
    if (!getTenantContext()) {
      return Promise.reject(new Error('No tenant context for AiAgent.count at TENANCY_MODE=multi'));
    }
    return Promise.resolve(count);
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getSetupState', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.TENANCY_MODE = 'single';
    vi.mocked(requestPrincipal).mockResolvedValue(enteredOrg('org_install'));
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

  describe('at TENANCY_MODE=multi (#1295)', () => {
    beforeEach(() => {
      mockEnv.TENANCY_MODE = 'multi';
    });

    it('counts agents inside the org the viewer entered, so a fresh org reads as not set up', async () => {
      vi.mocked(requestPrincipal).mockResolvedValue(enteredOrg('org_a'));
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);
      vi.mocked(prisma.aiAgent.count).mockImplementation(agentCountRefusingWithoutOrg(0) as never);
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      const state = await getSetupState();

      // Before the fix the agent count ran with no org, the data layer
      // refused it, and the catch answered "everything set up".
      expect(state).toEqual({ hasProvider: false, hasAgent: false, hasDefaultChatModel: false });
    });

    it('runs the agent count as the entered org, not another', async () => {
      vi.mocked(requestPrincipal).mockResolvedValue(enteredOrg('org_a'));
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(1);
      let orgAtCount: string | null | undefined;
      vi.mocked(prisma.aiAgent.count).mockImplementation((() => {
        orgAtCount = getTenantContext()?.orgId;
        return Promise.resolve(3);
      }) as never);
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      const state = await getSetupState();

      expect(orgAtCount).toBe('org_a');
      expect(state.hasAgent).toBe(true);
      // The scope does not leak out of the probe.
      expect(getTenantContext()).toBeNull();
    });

    it('with no org entered, skips the agent count and still answers the platform-wide probes', async () => {
      vi.mocked(requestPrincipal).mockResolvedValue(null);
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);
      vi.mocked(prisma.aiAgent.count).mockImplementation(agentCountRefusingWithoutOrg(0) as never);
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      const state = await getSetupState();

      // hasAgent is per org and cannot be asked without one, so it takes the
      // quiet answer; hasProvider is platform-wide and must not be lost with it.
      expect(prisma.aiAgent.count).not.toHaveBeenCalled();
      expect(state).toEqual({ hasProvider: false, hasAgent: true, hasDefaultChatModel: false });
    });

    it('still falls back to "everything-set-up" on a real DB failure inside the org', async () => {
      vi.mocked(requestPrincipal).mockResolvedValue(enteredOrg('org_a'));
      vi.mocked(prisma.aiProviderConfig.count).mockResolvedValue(0);
      vi.mocked(prisma.aiAgent.count).mockRejectedValue(new Error('connection lost'));
      vi.mocked(prisma.aiOrchestrationSettings.findUnique).mockResolvedValue(null);

      const state = await getSetupState();

      expect(state).toEqual({ hasProvider: true, hasAgent: true, hasDefaultChatModel: true });
    });
  });
});
