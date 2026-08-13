/**
 * Tests: CAPABILITY_BINDING_MODE — what a MISSING `AiAgentCapability` row means.
 *
 * Lives in its own file because the mode is read from `@/lib/env` at dispatch
 * time, and mocking that module is file-scoped.
 *
 * The behaviour under test is the one that surprised a downstream fork: a
 * missing pivot row is PERMISSIVE by default, so deleting a grant does not
 * revoke a capability — it widens it, because the deleted row was also what
 * carried the `customConfig` pin narrowing the tool's scope. The operator
 * action that reads as "remove this permission" is the one that removes the
 * restriction.
 *
 * @see lib/orchestration/capabilities/dispatcher.ts — getAgentBinding
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiCapability: { findMany: vi.fn() },
    aiAgentCapability: { findMany: vi.fn() },
    aiAgent: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/orchestration/llm/cost-tracker', () => ({
  logCost: vi.fn().mockResolvedValue(null),
}));

// The subject of this file: pin the mode per-test via this mutable holder.
const envHolder = { CAPABILITY_BINDING_MODE: 'permissive' as 'permissive' | 'strict' };
vi.mock('@/lib/env', () => ({
  env: new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'CAPABILITY_BINDING_MODE' ? envHolder.CAPABILITY_BINDING_MODE : undefined,
    }
  ),
}));

const { prisma } = await import('@/lib/db/client');
const { capabilityDispatcher, workflowAgentId } =
  await import('@/lib/orchestration/capabilities/dispatcher');
const { BaseCapability } = await import('@/lib/orchestration/capabilities/base-capability');
const { logCost } = await import('@/lib/orchestration/llm/cost-tracker');

class OkCapability extends BaseCapability<{ n: number }, { doubled: number }> {
  readonly slug = 'ok';
  readonly functionDefinition = { name: 'ok', description: '', parameters: {} };
  protected readonly schema = z.object({ n: z.number() });

  async execute(args: { n: number }) {
    return this.success({ doubled: args.n * 2 });
  }
}

const ctx = { userId: 'user-1', agentId: 'agent-1', conversationId: 'conv-1' };

function makeCapabilityRow() {
  return {
    id: 'cap-1',
    slug: 'ok',
    name: 'ok',
    category: 'test',
    functionDefinition: { name: 'ok', description: '', parameters: {} },
    requiresApproval: false,
    rateLimit: null,
    approvalTimeoutMs: null,
    isIdempotent: false,
    isActive: true,
    quarantineState: 'active',
    quarantineReason: null,
    quarantineUntil: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  capabilityDispatcher.clearCache();
  envHolder.CAPABILITY_BINDING_MODE = 'permissive';
  capabilityDispatcher.register(new OkCapability());
  (prisma.aiCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    makeCapabilityRow(),
  ]);
  (prisma.aiAgent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    knowledgeCategories: [],
  });
});

describe('CAPABILITY_BINDING_MODE', () => {
  describe("'permissive' (default)", () => {
    it('dispatches when NO binding row exists — deleting a grant does not revoke', async () => {
      // This is the documented hazard, asserted so it cannot change silently.
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 2 }, ctx);

      expect(result).toEqual({ success: true, data: { doubled: 4 } });
    });

    it('still refuses when the row exists and is disabled — the real revocation', async () => {
      // The supported way to revoke: keep the row, set isEnabled false.
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          agentId: 'agent-1',
          isEnabled: false,
          customRateLimit: null,
          customConfig: null,
          capability: makeCapabilityRow(),
        },
      ]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 2 }, ctx);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('capability_disabled_for_agent');
    });
  });

  describe("'strict'", () => {
    it('REFUSES when no binding row exists', async () => {
      envHolder.CAPABILITY_BINDING_MODE = 'strict';
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 2 }, ctx);

      // Regression guard for a subtle bug: the dispatch gate used to read
      // `if (binding && binding.isEnabled === false)`, so a null binding fell
      // THROUGH to a successful dispatch and the whole setting was a no-op.
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('capability_disabled_for_agent');
    });

    it('dispatches normally when an enabled binding row exists', async () => {
      envHolder.CAPABILITY_BINDING_MODE = 'strict';
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          agentId: 'agent-1',
          isEnabled: true,
          customRateLimit: null,
          customConfig: null,
          capability: makeCapabilityRow(),
        },
      ]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 3 }, ctx);

      expect(result).toEqual({ success: true, data: { doubled: 6 } });
    });
  });

  /**
   * A workflow execution has no agent, so `tool_call` steps dispatch under a
   * LABEL — `workflow:${workflowId}`. `AiAgentCapability.agentId` is a FK to
   * `AiAgent.id`, so that label can never have a binding row: the FK rejects
   * the insert.
   *
   * That is what made strict mode a trap rather than a hardening measure
   * (#528). The env description's advice — audit the table, add the rows you
   * need — is actionable for `mcp-system`, which is a real seeded agent row.
   * For a workflow there is no row to add, so strict failed EVERY tool_call
   * step in EVERY workflow with no configuration that fixed it, and the error
   * (`capability_disabled_for_agent`, per-step) read as a capability
   * misconfiguration rather than a mode-wide one.
   */
  describe('workflow tool_call steps (#528)', () => {
    const workflowCtx = { ...ctx, agentId: workflowAgentId('wf_abc123') };

    it('dispatches under STRICT — the binding row strict would demand cannot exist', async () => {
      envHolder.CAPABILITY_BINDING_MODE = 'strict';
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 4 }, workflowCtx);

      expect(result).toEqual({ success: true, data: { doubled: 8 } });
    });

    it('does not query AiAgentCapability at all for a workflow label', async () => {
      // Not a performance assertion — it is how we know the exemption is a
      // real short-circuit and not a query that happens to return zero rows.
      envHolder.CAPABILITY_BINDING_MODE = 'strict';
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await capabilityDispatcher.dispatch('ok', { n: 1 }, workflowCtx);

      expect(prisma.aiAgentCapability.findMany).not.toHaveBeenCalled();
    });

    it('leaves permissive behaviour identical', async () => {
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 5 }, workflowCtx);

      expect(result).toEqual({ success: true, data: { doubled: 10 } });
    });

    it('never writes the workflow label to AiCostLog.agentId — it is not an AiAgent.id', async () => {
      // `AiCostLog.agentId` is an FK to `AiAgent.id`. Writing `workflow:<id>`
      // there is rejected by Postgres with P2003
      // (`ai_cost_log_agentId_fkey` — reproduced against a real dev DB), and
      // `logCost` swallows the rejection into an error log and returns null.
      // So every capability a workflow invoked logged an error and recorded no
      // cost row at all, and the Costs page's per-tool breakdown reported zero
      // for them. A mocked prisma cannot enforce an FK, so this asserts the
      // shape that the FK would have rejected.
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await capabilityDispatcher.dispatch(
        'ok',
        { n: 7 },
        { ...workflowCtx, workflowExecutionId: 'exec_abc' }
      );

      expect(logCost).toHaveBeenCalledTimes(1);
      const logged = (logCost as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(logged.agentId).toBeUndefined();
      // Positive half: the row still lands, linked by the FK that IS real.
      // Without this, dropping `workflowExecutionId` entirely would pass.
      expect(logged.workflowExecutionId).toBe('exec_abc');
      expect(logged.operation).toBe('tool_call');
    });

    it('still records agentId for a REAL agent — the omission is workflow-only', async () => {
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await capabilityDispatcher.dispatch('ok', { n: 8 }, ctx);

      const logged = (logCost as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(logged.agentId).toBe('agent-1');
    });

    it('still denies a REAL agent id under strict — the exemption is not a blanket off-switch', async () => {
      // The guard that matters: this must keep failing, or the fix has turned
      // strict mode into a no-op for everyone rather than exempting one caller.
      envHolder.CAPABILITY_BINDING_MODE = 'strict';
      (prisma.aiAgentCapability.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const result = await capabilityDispatcher.dispatch('ok', { n: 6 }, ctx);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('capability_disabled_for_agent');
    });
  });
});
