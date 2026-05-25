/**
 * Unit tests for trace-to-dataset capture helpers.
 *
 * Coverage:
 * - Conversation: rejects non-assistant messages
 * - Conversation: throws when there's no preceding user turn
 * - Conversation: maps user→input, assistant→expectedOutput, provenance.citations→referenceCitations
 * - Conversation: edits override captured fields without losing the rest
 * - Workflow: rejects non-completed executions
 * - Workflow: selector kind=last_step picks the last completed trace entry
 * - Workflow: selector kind=step_id requires a match in the trace
 * - Workflow: selector kind=final_report falls back to outputData when no report step exists
 *
 * @see lib/orchestration/evaluations/datasets/capture.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/client', () => ({
  prisma: {
    aiMessage: { findUnique: vi.fn(), findFirst: vi.fn() },
    aiWorkflowExecution: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/logging', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockedAppend = vi.fn();
vi.mock('@/lib/orchestration/evaluations/datasets/append-cases', () => ({
  appendCasesToDataset: (...args: unknown[]) => mockedAppend(...args),
}));

import { prisma } from '@/lib/db/client';
import {
  captureConversationTurnAsCase,
  captureWorkflowExecutionAsCase,
} from '@/lib/orchestration/evaluations/datasets/capture';

const mockedPrisma = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
  mockedAppend.mockResolvedValue({
    datasetId: 'ds-1',
    appendedCount: 1,
    newCaseCount: 4,
    newContentHash: 'h',
  });
});

describe('captureConversationTurnAsCase', () => {
  it('throws when the source message is not role=assistant', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm1',
      role: 'user',
      content: 'hello',
      provenance: null,
      conversationId: 'c1',
      createdAt: new Date('2026-01-01'),
      conversation: { id: 'c1', agentId: 'a1', contextType: null },
    } as never);

    await expect(
      captureConversationTurnAsCase({ datasetId: 'ds-1', messageId: 'm1' })
    ).rejects.toThrow(/assistant turn/i);
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it('throws when no preceding user turn exists', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm1',
      role: 'assistant',
      content: 'A',
      provenance: null,
      conversationId: 'c1',
      createdAt: new Date('2026-01-01'),
      conversation: { id: 'c1', agentId: 'a1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue(null);

    await expect(
      captureConversationTurnAsCase({ datasetId: 'ds-1', messageId: 'm1' })
    ).rejects.toThrow(/no preceding user turn/i);
  });

  it('maps user→input, assistant→expectedOutput, citations→referenceCitations', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm-assistant',
      role: 'assistant',
      content: 'Refunds within 30 days.',
      provenance: { citations: [{ marker: 1, documentName: 'Policy.pdf', excerpt: '…' }] },
      conversationId: 'c1',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      conversation: { id: 'c1', agentId: 'agent-1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue({
      id: 'm-user',
      content: 'What is the refund policy?',
      createdAt: new Date('2026-01-01T09:59:00Z'),
    } as never);

    await captureConversationTurnAsCase({ datasetId: 'ds-1', messageId: 'm-assistant' });

    expect(mockedAppend).toHaveBeenCalledWith({
      datasetId: 'ds-1',
      cases: [
        expect.objectContaining({
          input: 'What is the refund policy?',
          expectedOutput: 'Refunds within 30 days.',
          referenceCitations: [{ marker: 1, documentName: 'Policy.pdf', excerpt: '…' }],
          metadata: expect.objectContaining({
            source: 'conversation_capture',
            sourceMessageId: 'm-assistant',
            sourceUserMessageId: 'm-user',
            agentId: 'agent-1',
          }),
        }),
      ],
      source: 'conversation_capture',
    });
  });

  it('applies edits over the captured fields without losing the rest', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm-assistant',
      role: 'assistant',
      content: 'Original answer.',
      provenance: null,
      conversationId: 'c1',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      conversation: { id: 'c1', agentId: 'agent-1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue({
      id: 'm-user',
      content: 'Original question.',
      createdAt: new Date('2026-01-01T09:59:00Z'),
    } as never);

    await captureConversationTurnAsCase({
      datasetId: 'ds-1',
      messageId: 'm-assistant',
      edits: {
        expectedOutput: 'Tightened answer.',
        metadataPatch: { adminNote: 'Cleaned up' },
      },
    });

    expect(mockedAppend).toHaveBeenCalledWith({
      datasetId: 'ds-1',
      cases: [
        expect.objectContaining({
          input: 'Original question.', // not overridden
          expectedOutput: 'Tightened answer.', // overridden
          metadata: expect.objectContaining({
            source: 'conversation_capture',
            adminNote: 'Cleaned up',
          }),
        }),
      ],
      source: 'conversation_capture',
    });
  });
});

describe('captureWorkflowExecutionAsCase', () => {
  it('rejects non-completed executions', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'running',
      inputData: { topic: 'x' },
      outputData: null,
      executionTrace: [],
    } as never);

    await expect(
      captureWorkflowExecutionAsCase({
        datasetId: 'ds-1',
        executionId: 'e1',
        selector: { kind: 'last_step' },
      })
    ).rejects.toThrow(/only completed runs/i);
  });

  it('selector=last_step picks the last completed trace entry', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'refunds' },
      outputData: null,
      executionTrace: [
        { stepId: 's1', status: 'completed', output: 'first' },
        { stepId: 's2', status: 'failed', output: null },
        { stepId: 's3', status: 'completed', output: 'final answer' },
      ],
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      executionId: 'e1',
      selector: { kind: 'last_step' },
    });

    expect(mockedAppend).toHaveBeenCalledWith({
      datasetId: 'ds-1',
      cases: [
        expect.objectContaining({
          input: { topic: 'refunds' },
          expectedOutput: 'final answer',
        }),
      ],
      // Dataset-level provenance must match the per-case
      // metadata.source ('workflow_capture'), not the
      // conversation-capture value the helper writes in the sibling
      // entry point.
      source: 'workflow_capture',
    });
  });

  it('selector=step_id requires a matching completed entry; throws otherwise', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: null,
      executionTrace: [{ stepId: 's1', status: 'completed', output: 'A' }],
    } as never);

    await expect(
      captureWorkflowExecutionAsCase({
        datasetId: 'ds-1',
        executionId: 'e1',
        selector: { kind: 'step_id', stepId: 's-missing' },
      })
    ).rejects.toThrow(/did not resolve/i);
  });

  it('selector=final_report falls back to outputData when no report step ran', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: { final: 'fallback result' },
      executionTrace: [{ stepId: 's1', status: 'completed', stepType: 'agent_call', output: 'A' }],
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      executionId: 'e1',
      selector: { kind: 'final_report' },
    });

    const call = mockedAppend.mock.calls[0][0] as { cases: Array<{ expectedOutput: string }> };
    expect(call.cases[0].expectedOutput).toContain('fallback result');
  });
});
