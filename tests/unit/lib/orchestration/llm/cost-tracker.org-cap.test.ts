/**
 * Tests: the per-org monthly budget cap in checkBudget() (§110 t-788).
 *
 * The org's spend is summed with an explicit `orgId` filter, so the mocked
 * aggregate answers from a per-org ledger keyed on that filter: drop the
 * filter and the sum becomes both orgs' spend, and org B — under its cap on
 * its own — reads as over it. With no `quotas` set the result is the one
 * checkBudget() gave before the cap existed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({
  aiCostLog: { aggregate: vi.fn() },
  aiAgent: { findUnique: vi.fn() },
  aiOrchestrationSettings: { findUnique: vi.fn() },
  org: { findUnique: vi.fn() },
}));
vi.mock('@/lib/db/client', () => ({ prisma: db }));
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/logging', () => ({ logger: mockLogger }));

import { checkBudget } from '@/lib/orchestration/llm/cost-tracker';
import { forgetSpendCaps } from '@/lib/orchestration/llm/spend-caps';

const ORG_A = 'cmorg0000000000000000orga';
const ORG_B = 'cmorg0000000000000000orgb';

/** This month's spend, per org and per agent. */
const ledger = {
  org: { [ORG_A]: 50, [ORG_B]: 5 } as Record<string, number>,
  agent: { 'agent-a': 50, 'agent-b': 5 } as Record<string, number>,
};

/** Each org's stored `settings`. */
let orgSettings: Record<string, unknown>;

function sumFor(where: { agentId?: string; orgId?: string }): number {
  if (where.agentId) return ledger.agent[where.agentId] ?? 0;
  if (where.orgId) return ledger.org[where.orgId] ?? 0;
  return Object.values(ledger.org).reduce((a, b) => a + b, 0);
}

beforeEach(() => {
  // The month-to-date totals are cached across calls; each test starts cold.
  forgetSpendCaps();
  vi.clearAllMocks();
  orgSettings = {
    [ORG_A]: { quotas: { monthlyBudgetUsd: 40 } },
    [ORG_B]: { quotas: { monthlyBudgetUsd: 40 } },
  };
  db.aiCostLog.aggregate.mockImplementation(
    async (args: { where: { agentId?: string; orgId?: string } }) => ({
      _sum: { totalCostUsd: sumFor(args.where) },
    })
  );
  db.aiAgent.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
    monthlyBudgetUsd: null,
    orgId: args.where.id === 'agent-a' ? ORG_A : ORG_B,
  }));
  db.aiOrchestrationSettings.findUnique.mockResolvedValue({ globalMonthlyBudgetUsd: null });
  db.org.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id in orgSettings ? { settings: orgSettings[args.where.id] } : null
  );
});

describe('checkBudget — org cap', () => {
  it("blocks org A's turns once A's spend reaches its cap, and not org B's", async () => {
    const a = await checkBudget('agent-a');
    const b = await checkBudget('agent-b');

    expect(a).toMatchObject({
      withinBudget: false,
      orgCapExceeded: true,
      org: { limit: 40, spent: 50 },
    });
    expect(a.globalCapExceeded).toBeUndefined();
    // B's own spend is $5 of $40; A's $50 must not be counted against it.
    expect(b).toMatchObject({ withinBudget: true, org: { limit: 40, spent: 5 } });
    expect(b.orgCapExceeded).toBeUndefined();
  });

  it("sums the org's spend with an explicit orgId filter from the start of the UTC month", async () => {
    await checkBudget('agent-a');

    const orgCall = db.aiCostLog.aggregate.mock.calls.find(
      ([args]) => (args as { where: { orgId?: string } }).where.orgId !== undefined
    );
    const where = (orgCall?.[0] as { where: { orgId: string; createdAt: { gte: Date } } }).where;
    expect(where.orgId).toBe(ORG_A);
    const now = new Date();
    expect(where.createdAt.gte).toEqual(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    );
  });

  it('blocks at exactly the cap, and a zero cap blocks a free org', async () => {
    orgSettings[ORG_B] = { quotas: { monthlyBudgetUsd: 5 } };
    expect(await checkBudget('agent-b')).toMatchObject({
      withinBudget: false,
      orgCapExceeded: true,
    });

    ledger.org[ORG_B] = 0;
    orgSettings[ORG_B] = { quotas: { monthlyBudgetUsd: 0 } };
    expect(await checkBudget('agent-b')).toMatchObject({
      withinBudget: false,
      orgCapExceeded: true,
    });
    ledger.org[ORG_B] = 5;
  });

  it('reports the agent cap and the org cap side by side when both apply', async () => {
    db.aiAgent.findUnique.mockResolvedValueOnce({ monthlyBudgetUsd: 100, orgId: ORG_A });

    const status = await checkBudget('agent-a');

    // Within the agent's $100, over the org's $40.
    expect(status).toMatchObject({
      withinBudget: false,
      limit: 100,
      remaining: 50,
      orgCapExceeded: true,
    });
  });

  it('the global cap still applies to an org under its own cap', async () => {
    db.aiOrchestrationSettings.findUnique.mockResolvedValue({ globalMonthlyBudgetUsd: 50 });

    const b = await checkBudget('agent-b');

    // B is at $5 of its $40, but the install has spent $55 of $50.
    expect(b).toMatchObject({ withinBudget: false, globalCapExceeded: true });
    expect(b.orgCapExceeded).toBeUndefined();
  });
});

describe('checkBudget — no org cap set (behaviour-neutral)', () => {
  /**
   * What checkBudget returned for an agent before org caps existed, plus the
   * flag naming the agent's own cap when it is the one reached (§137 t-1046).
   */
  const before = (spent: number, limit: number | null) => ({
    withinBudget: limit === null || spent < limit,
    spent,
    limit,
    remaining: limit === null ? null : limit - spent,
    ...(limit !== null && spent >= limit ? { agentCapExceeded: true } : {}),
  });

  it.each([
    ['no settings at all', null],
    ['settings with no quotas key', { retention: { webhookRetentionDays: 7 } }],
    ['an empty quotas slice', { quotas: {} }],
  ])('returns the pre-cap result with %s', async (_label, settings) => {
    orgSettings[ORG_A] = settings;

    expect(await checkBudget('agent-a')).toEqual(before(50, null));

    db.aiAgent.findUnique.mockResolvedValueOnce({ monthlyBudgetUsd: 40, orgId: ORG_A });
    expect(await checkBudget('agent-a')).toEqual(before(50, 40));

    // The org's spend is never summed when there is no cap to check it against.
    const orgSums = db.aiCostLog.aggregate.mock.calls.filter(
      ([args]) => (args as { where: { orgId?: string } }).where.orgId !== undefined
    );
    expect(orgSums).toHaveLength(0);
  });

  it('an agent with no org has no org cap, and no org is read', async () => {
    db.aiAgent.findUnique.mockResolvedValueOnce({ monthlyBudgetUsd: null, orgId: null });

    expect(await checkBudget('agent-a')).toEqual(before(50, null));
    expect(db.org.findUnique).not.toHaveBeenCalled();
  });

  it('a malformed cap is dropped with a warning and the org is not capped by it', async () => {
    orgSettings[ORG_A] = { quotas: { monthlyBudgetUsd: 'lots' } };

    expect(await checkBudget('agent-a')).toEqual(before(50, null));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Dropped malformed org caps; the org is not capped by them',
      expect.objectContaining({ orgId: ORG_A, keys: ['monthlyBudgetUsd'] })
    );
  });

  it('a failed org lookup is logged and skipped, never failing the agent check', async () => {
    db.org.findUnique.mockRejectedValueOnce(new Error('db down'));

    expect(await checkBudget('agent-a')).toEqual(before(50, null));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Spend caps: the org cap could not be read, so it is skipped',
      expect.objectContaining({ agentId: 'agent-a', orgId: ORG_A, error: 'db down' })
    );
  });
});
