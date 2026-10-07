import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConvFindFirst, mockAgentFindUnique, mockGetModel, mockHydrate } = vi.hoisted(() => ({
  mockConvFindFirst: vi.fn(),
  mockAgentFindUnique: vi.fn(),
  mockGetModel: vi.fn(),
  mockHydrate: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiConversation: { findFirst: mockConvFindFirst },
    aiAgent: { findUnique: mockAgentFindUnique },
  },
}));

vi.mock('@/lib/orchestration/llm/model-registry', () => ({
  getModel: mockGetModel,
}));

vi.mock('@/lib/orchestration/llm/model-registry-db-hydrate', () => ({
  hydrateFromDb: mockHydrate,
}));

import { resolveCleanupAgentContextWindow } from '@/lib/orchestration/knowledge/cleanup-agent';

const DOC_ID = 'doc-xyz-001';
const FALLBACK = 128_000;

describe('resolveCleanupAgentContextWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the fallback context window when no cleanup conversation exists', async () => {
    mockConvFindFirst.mockResolvedValue(null);

    const ctx = await resolveCleanupAgentContextWindow(DOC_ID);

    expect(ctx).toBe(FALLBACK);
    expect(mockConvFindFirst).toHaveBeenCalledWith({
      where: { contextType: 'knowledge_document', contextId: DOC_ID },
      orderBy: { createdAt: 'desc' },
      select: { agentId: true },
    });
    // No agent / model lookups when there's no conversation to anchor to.
    expect(mockAgentFindUnique).not.toHaveBeenCalled();
    expect(mockGetModel).not.toHaveBeenCalled();
  });

  it('returns the fallback when the agent has no model configured', async () => {
    mockConvFindFirst.mockResolvedValue({ agentId: 'agent-1' });
    mockAgentFindUnique.mockResolvedValue({ model: null });

    const ctx = await resolveCleanupAgentContextWindow(DOC_ID);

    expect(ctx).toBe(FALLBACK);
    expect(mockGetModel).not.toHaveBeenCalled();
  });

  it("returns the fallback when the model isn't in the registry", async () => {
    mockConvFindFirst.mockResolvedValue({ agentId: 'agent-1' });
    mockAgentFindUnique.mockResolvedValue({ model: 'unknown/model' });
    mockGetModel.mockReturnValue(undefined);

    const ctx = await resolveCleanupAgentContextWindow(DOC_ID);

    expect(ctx).toBe(FALLBACK);
    expect(mockGetModel).toHaveBeenCalledWith('unknown/model');
  });

  it("returns the model's maxContext when the registry knows the model", async () => {
    mockConvFindFirst.mockResolvedValue({ agentId: 'agent-1' });
    mockAgentFindUnique.mockResolvedValue({ model: 'anthropic/claude-4-7' });
    mockGetModel.mockReturnValue({ maxContext: 1_000_000 });

    const ctx = await resolveCleanupAgentContextWindow(DOC_ID);

    expect(ctx).toBe(1_000_000);
  });

  it('hydrates the model registry before reading the window (#813)', async () => {
    // The refine route reaches the window through the resolver, which
    // hydrates; a matrix-only model must read the same here.
    mockHydrate.mockResolvedValue(undefined);
    mockConvFindFirst.mockResolvedValue({ agentId: 'agent-1' });
    mockAgentFindUnique.mockResolvedValue({ model: 'matrix-only-model' });
    mockGetModel.mockReturnValue({ maxContext: 32_000 });

    await resolveCleanupAgentContextWindow(DOC_ID);

    expect(mockHydrate.mock.invocationCallOrder[0]).toBeDefined();
    expect(mockHydrate.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetModel.mock.invocationCallOrder[0]
    );
  });
});
