import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiWorkflow: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from '@/lib/db/client';
import { handleWorkflowList } from '@/lib/orchestration/mcp/resources/workflow-list';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflow(
  overrides: Partial<{
    name: string;
    slug: string;
    description: string | null;
    isTemplate: boolean;
  }> = {}
) {
  return {
    name: 'Data Pipeline',
    slug: 'data-pipeline',
    description: 'Processes data end-to-end',
    isTemplate: false,
    ...overrides,
  };
}

const TEST_URI = 'sunrise://workflows';

// ---------------------------------------------------------------------------
// handleWorkflowList
// ---------------------------------------------------------------------------

describe('handleWorkflowList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('queries aiWorkflow with isActive=true filter', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    await handleWorkflowList(TEST_URI, null, { scopedAgentId: null, apiKeyId: 'key-1' });

    expect(prisma.aiWorkflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true },
      })
    );
  });

  it('orders results by name ascending', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    await handleWorkflowList(TEST_URI, null, { scopedAgentId: null, apiKeyId: 'key-1' });

    expect(prisma.aiWorkflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { name: 'asc' },
      })
    );
  });

  it('selects only safe fields', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    await handleWorkflowList(TEST_URI, null, { scopedAgentId: null, apiKeyId: 'key-1' });

    expect(prisma.aiWorkflow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          name: true,
          slug: true,
          description: true,
          isTemplate: true,
        },
      })
    );
  });

  it('returns mimeType application/json', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    const result = await handleWorkflowList(TEST_URI, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(result.mimeType).toBe('application/json');
  });

  it('echoes the URI back in the result', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    const result = await handleWorkflowList(TEST_URI, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    expect(result.uri).toBe(TEST_URI);
  });

  it('returns empty workflows array when no active workflows exist', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    const result = await handleWorkflowList(TEST_URI, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.workflows).toEqual([]);
  });

  it('maps workflows to the response body correctly', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([makeWorkflow()] as never);

    const result = await handleWorkflowList(TEST_URI, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.workflows).toHaveLength(1);
    expect(body.workflows[0]).toEqual({
      name: 'Data Pipeline',
      slug: 'data-pipeline',
      description: 'Processes data end-to-end',
      isTemplate: false,
    });
  });

  it('handles multiple workflows', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      makeWorkflow({ name: 'Workflow A', slug: 'workflow-a' }),
      makeWorkflow({ name: 'Workflow B', slug: 'workflow-b' }),
    ] as never);

    const result = await handleWorkflowList(TEST_URI, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.workflows).toHaveLength(2);
    expect(body.workflows.map((w: { slug: string }) => w.slug)).toEqual([
      'workflow-a',
      'workflow-b',
    ]);
  });

  it('includes isTemplate flag in each workflow', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      makeWorkflow({ isTemplate: true }),
    ] as never);

    const result = await handleWorkflowList(TEST_URI, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    // test-review:accept tobe_true — boolean schema field `isTemplate`; structural assertion on workflow data shape
    expect(body.workflows[0].isTemplate).toBe(true);
  });

  it('handles workflows with null description', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([
      makeWorkflow({ description: null }),
    ] as never);

    const result = await handleWorkflowList(TEST_URI, null, {
      scopedAgentId: null,
      apiKeyId: 'key-1',
    });

    const body = JSON.parse(result.text);
    expect(body.workflows[0].description).toBeNull();
  });

  it('ignores the config parameter', async () => {
    vi.mocked(prisma.aiWorkflow.findMany).mockResolvedValue([]);

    await expect(
      handleWorkflowList(
        TEST_URI,
        { someConfig: 'value' },
        { scopedAgentId: null, apiKeyId: 'key-1' }
      )
    ).resolves.not.toThrow();
  });
});
