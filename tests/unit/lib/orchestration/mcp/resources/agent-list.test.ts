import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiAgent: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { handleAgentList } from '@/lib/orchestration/mcp/resources/agent-list';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(
  overrides: Partial<{
    name: string;
    slug: string;
    description: string | null;
    model: string;
    provider: string;
  }> = {}
) {
  return {
    name: 'Research Agent',
    slug: 'research-agent',
    description: 'Performs research tasks',
    model: 'gpt-4o',
    provider: 'openai',
    ...overrides,
  };
}

const TEST_URI = 'sunrise://agents';

// ---------------------------------------------------------------------------
// handleAgentList
// ---------------------------------------------------------------------------

describe('handleAgentList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries aiAgent with isActive=true filter', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    await handleAgentList(TEST_URI, null);

    expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
      })
    );
  });

  it('orders results by name ascending', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    await handleAgentList(TEST_URI, null);

    expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { name: 'asc' },
      })
    );
  });

  it('selects only safe fields (no system instructions or config)', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    await handleAgentList(TEST_URI, null);

    expect(prisma.aiAgent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          name: true,
          slug: true,
          description: true,
          model: true,
          provider: true,
        },
      })
    );
  });

  it('returns mimeType application/json', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    const result = await handleAgentList(TEST_URI, null);

    expect(result.mimeType).toBe('application/json');
  });

  it('echoes the URI back in the result', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    const result = await handleAgentList(TEST_URI, null);

    expect(result.uri).toBe(TEST_URI);
  });

  it('returns empty agents array when no active agents exist', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    const result = await handleAgentList(TEST_URI, null);

    const body = JSON.parse(result.text);
    expect(body.agents).toEqual([]);
  });

  it('maps agents to the response body correctly', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([makeAgent()] as never);

    const result = await handleAgentList(TEST_URI, null);

    const body = JSON.parse(result.text);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0]).toEqual({
      name: 'Research Agent',
      slug: 'research-agent',
      description: 'Performs research tasks',
      model: 'gpt-4o',
      provider: 'openai',
    });
  });

  it('handles multiple agents', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      makeAgent({ name: 'Agent A', slug: 'agent-a' }),
      makeAgent({ name: 'Agent B', slug: 'agent-b' }),
    ] as never);

    const result = await handleAgentList(TEST_URI, null);

    const body = JSON.parse(result.text);
    expect(body.agents).toHaveLength(2);
    expect(body.agents.map((a: { slug: string }) => a.slug)).toEqual(['agent-a', 'agent-b']);
  });

  it('handles agents with null description', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([
      makeAgent({ description: null }),
    ] as never);

    const result = await handleAgentList(TEST_URI, null);

    const body = JSON.parse(result.text);
    expect(body.agents[0].description).toBeNull();
  });

  it('ignores the config parameter', async () => {
    vi.mocked(prisma.aiAgent.findMany).mockResolvedValue([]);

    await expect(handleAgentList(TEST_URI, { someConfig: 'value' })).resolves.not.toThrow();
  });
});
