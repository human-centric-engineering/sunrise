/**
 * Unit tests for trace-to-dataset capture helpers.
 *
 * Coverage:
 * - Conversation: rejects non-assistant messages
 * - Conversation: throws when there's no preceding user turn
 * - Conversation: throws 404 when message not found
 * - Conversation: maps user→input, assistant→expectedOutput, provenance.citations→referenceCitations
 * - Conversation: null provenance → no referenceCitations
 * - Conversation: provenance.citations is not an array → no referenceCitations
 * - Conversation: edits override captured fields without losing the rest
 * - applyEdits: empty referenceCitations array is dropped
 * - applyEdits: no edits → captured values pass through
 * - applyEdits: edits without metadataPatch → metadata unchanged
 * - Workflow: rejects non-completed executions
 * - Workflow: throws 404 when execution not found
 * - Workflow: selector kind=last_step picks the last completed trace entry
 * - Workflow: selector kind=last_step with non-array trace falls back to outputData
 * - Workflow: selector kind=last_step with no completed entries and no outputData → throws
 * - Workflow: selector kind=step_id requires a match in the trace
 * - Workflow: selector kind=step_id with no stepId → throws
 * - Workflow: selector kind=step_id matching step with null output → throws
 * - Workflow: selector kind=step_id matching step with object output → JSON-stringified
 * - Workflow: selector kind=final_report happy path (report step exists)
 * - Workflow: selector kind=final_report picks the LAST report step, not the first
 * - Workflow: selector kind=final_report no report step AND no outputData → throws
 * - Workflow: selector kind=final_report falls back to outputData when no report step exists
 * - Workflow: inputData is array → wrapped as { input: [...] }
 * - Workflow: inputData is null → wrapped as { input: null }
 * - resolveSelectorOutput: round-trip parity with captureWorkflowExecutionAsCase
 *
 * @see lib/orchestration/evaluations/datasets/capture.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The owner the calling route observed — see `appendCasesToDataset`. */
const OWNER_ID = 'admin-1';

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
  resolveSelectorOutput,
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
      captureConversationTurnAsCase({
        datasetId: 'ds-1',
        observedOwnerId: OWNER_ID,
        messageId: 'm1',
      })
    ).rejects.toThrow(/assistant turn/i);
    expect(mockedAppend).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the message does not exist (gap 1)', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue(null);

    await expect(
      captureConversationTurnAsCase({
        datasetId: 'ds-1',
        observedOwnerId: OWNER_ID,
        messageId: 'missing-msg',
      })
    ).rejects.toThrow(/Message missing-msg not found/);
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
      captureConversationTurnAsCase({
        datasetId: 'ds-1',
        observedOwnerId: OWNER_ID,
        messageId: 'm1',
      })
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

    await captureConversationTurnAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      messageId: 'm-assistant',
    });

    expect(mockedAppend).toHaveBeenCalledWith({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
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

  it('null provenance → captured case has no referenceCitations (gap 2)', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm-assistant',
      role: 'assistant',
      content: 'Answer.',
      provenance: null,
      conversationId: 'c1',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      conversation: { id: 'c1', agentId: 'a1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue({
      id: 'm-user',
      content: 'Question?',
      createdAt: new Date('2026-01-01T09:59:00Z'),
    } as never);

    await captureConversationTurnAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      messageId: 'm-assistant',
    });

    const passedCase = (mockedAppend.mock.calls[0][0] as { cases: Array<Record<string, unknown>> })
      .cases[0];
    expect(passedCase).not.toHaveProperty('referenceCitations');
  });

  it('provenance.citations is not an array → no referenceCitations (gap 3)', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm-assistant',
      role: 'assistant',
      content: 'Answer.',
      provenance: { citations: 'not-an-array' },
      conversationId: 'c1',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      conversation: { id: 'c1', agentId: 'a1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue({
      id: 'm-user',
      content: 'Question?',
      createdAt: new Date('2026-01-01T09:59:00Z'),
    } as never);

    await captureConversationTurnAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      messageId: 'm-assistant',
    });

    const passedCase = (mockedAppend.mock.calls[0][0] as { cases: Array<Record<string, unknown>> })
      .cases[0];
    expect(passedCase).not.toHaveProperty('referenceCitations');
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
      observedOwnerId: OWNER_ID,
      messageId: 'm-assistant',
      edits: {
        expectedOutput: 'Tightened answer.',
        metadataPatch: { adminNote: 'Cleaned up' },
      },
    });

    expect(mockedAppend).toHaveBeenCalledWith({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
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

  it('applyEdits: empty referenceCitations array is DROPPED from the output (gap 15)', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm-assistant',
      role: 'assistant',
      content: 'Answer.',
      provenance: { citations: [{ id: 1 }] }, // captured non-empty
      conversationId: 'c1',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      conversation: { id: 'c1', agentId: 'a1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue({
      id: 'm-user',
      content: 'Question?',
      createdAt: new Date('2026-01-01T09:59:00Z'),
    } as never);

    await captureConversationTurnAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      messageId: 'm-assistant',
      edits: { referenceCitations: [] }, // override with empty array
    });

    const passedCase = (mockedAppend.mock.calls[0][0] as { cases: Array<Record<string, unknown>> })
      .cases[0];
    // Empty array must be dropped — the field should be absent, not `[]`
    expect(passedCase).not.toHaveProperty('referenceCitations');
  });

  it('applyEdits: no edits → all captured values pass through unchanged (gap 16)', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm-assistant',
      role: 'assistant',
      content: 'The answer.',
      provenance: { citations: [{ ref: 'doc-1' }] },
      conversationId: 'c1',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      conversation: { id: 'c1', agentId: 'a1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue({
      id: 'm-user',
      content: 'The question.',
      createdAt: new Date('2026-01-01T09:59:00Z'),
    } as never);

    // No edits param at all
    await captureConversationTurnAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      messageId: 'm-assistant',
    });

    const passedCase = (mockedAppend.mock.calls[0][0] as { cases: Array<Record<string, unknown>> })
      .cases[0];
    expect(passedCase.input).toBe('The question.');
    expect(passedCase.expectedOutput).toBe('The answer.');
    expect(passedCase.referenceCitations).toEqual([{ ref: 'doc-1' }]);
  });

  it('applyEdits: edits without metadataPatch → captured metadata unchanged (gap 17)', async () => {
    mockedPrisma.aiMessage.findUnique.mockResolvedValue({
      id: 'm-assistant',
      role: 'assistant',
      content: 'Original.',
      provenance: null,
      conversationId: 'c1',
      createdAt: new Date('2026-01-01T10:00:00Z'),
      conversation: { id: 'c1', agentId: 'a1', contextType: null },
    } as never);
    mockedPrisma.aiMessage.findFirst.mockResolvedValue({
      id: 'm-user',
      content: 'Q?',
      createdAt: new Date('2026-01-01T09:59:00Z'),
    } as never);

    // edits with only expectedOutput — no metadataPatch
    await captureConversationTurnAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      messageId: 'm-assistant',
      edits: { expectedOutput: 'Overridden.' },
    });

    const passedCase = (mockedAppend.mock.calls[0][0] as { cases: Array<Record<string, unknown>> })
      .cases[0];
    // metadata must still contain the captured source field (not wiped)
    expect(passedCase.metadata).toMatchObject({ source: 'conversation_capture' });
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
        observedOwnerId: OWNER_ID,
        executionId: 'e1',
        selector: { kind: 'last_step' },
      })
    ).rejects.toThrow(/only completed runs/i);
  });

  it('throws NotFoundError when the execution does not exist (gap 4)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue(null);

    await expect(
      captureWorkflowExecutionAsCase({
        datasetId: 'ds-1',
        observedOwnerId: OWNER_ID,
        executionId: 'missing-exec',
        selector: { kind: 'last_step' },
      })
    ).rejects.toThrow(/Workflow execution missing-exec not found/);
    expect(mockedAppend).not.toHaveBeenCalled();
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
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'last_step' },
    });

    expect(mockedAppend).toHaveBeenCalledWith({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
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

  it('selector=last_step with non-array trace falls back to outputData (gap 11)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: 'fallback from outputData',
      executionTrace: 'not-an-array', // non-array trace
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'last_step' },
    });

    const passedCase = (
      mockedAppend.mock.calls[0][0] as { cases: Array<{ expectedOutput: string }> }
    ).cases[0];
    expect(passedCase.expectedOutput).toBe('fallback from outputData');
  });

  it('selector=last_step with no completed entries and no outputData → throws (gap 12)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: null,
      executionTrace: [
        { stepId: 's1', status: 'failed', output: null },
        { stepId: 's2', status: 'running', output: undefined },
      ],
    } as never);

    await expect(
      captureWorkflowExecutionAsCase({
        datasetId: 'ds-1',
        observedOwnerId: OWNER_ID,
        executionId: 'e1',
        selector: { kind: 'last_step' },
      })
    ).rejects.toThrow(/did not resolve/i);
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
        observedOwnerId: OWNER_ID,
        executionId: 'e1',
        selector: { kind: 'step_id', stepId: 's-missing' },
      })
    ).rejects.toThrow(/did not resolve/i);
  });

  it('selector=step_id with stepId undefined → throws (gap 8)', async () => {
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
        observedOwnerId: OWNER_ID,
        executionId: 'e1',
        selector: { kind: 'step_id' }, // no stepId
      })
    ).rejects.toThrow(/did not resolve/i);
  });

  it('selector=step_id matching step with null output → throws (gap 9)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: null,
      executionTrace: [{ stepId: 's-target', status: 'completed', output: null }],
    } as never);

    await expect(
      captureWorkflowExecutionAsCase({
        datasetId: 'ds-1',
        observedOwnerId: OWNER_ID,
        executionId: 'e1',
        selector: { kind: 'step_id', stepId: 's-target' },
      })
    ).rejects.toThrow(/did not resolve/i);
  });

  it('selector=step_id matching step with object output → JSON-stringified (gap 10)', async () => {
    const objectOutput = { summary: 'All good', score: 42 };
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: null,
      executionTrace: [{ stepId: 's-target', status: 'completed', output: objectOutput }],
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'step_id', stepId: 's-target' },
    });

    const passedCase = (
      mockedAppend.mock.calls[0][0] as { cases: Array<{ expectedOutput: string }> }
    ).cases[0];
    // The route must stringify the object — not pass it as-is
    expect(passedCase.expectedOutput).toBe(JSON.stringify(objectOutput));
  });

  it('selector=final_report happy path: uses the completed report step (gap 5)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: 'should be ignored',
      executionTrace: [
        { stepId: 's-agent', stepType: 'agent_call', status: 'completed', output: 'agent step' },
        { stepId: 's-report', stepType: 'report', status: 'completed', output: 'the final report' },
      ],
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'final_report' },
    });

    const passedCase = (
      mockedAppend.mock.calls[0][0] as { cases: Array<{ expectedOutput: string }> }
    ).cases[0];
    // Must use the report step's output, not the fallback outputData
    expect(passedCase.expectedOutput).toBe('the final report');
  });

  it('selector=final_report returns the LAST report step when multiple exist (gap 6)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: null,
      executionTrace: [
        { stepId: 's-report-1', stepType: 'report', status: 'completed', output: 'first report' },
        { stepId: 's-middle', stepType: 'agent_call', status: 'completed', output: 'intermediate' },
        { stepId: 's-report-2', stepType: 'report', status: 'completed', output: 'second report' },
      ],
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'final_report' },
    });

    const passedCase = (
      mockedAppend.mock.calls[0][0] as { cases: Array<{ expectedOutput: string }> }
    ).cases[0];
    // Must be the LAST report step — not the first
    expect(passedCase.expectedOutput).toBe('second report');
  });

  it('selector=final_report no report step AND no outputData → throws (gap 7)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'x' },
      outputData: null,
      executionTrace: [
        { stepId: 's1', stepType: 'agent_call', status: 'completed', output: 'step output' },
      ],
    } as never);

    await expect(
      captureWorkflowExecutionAsCase({
        datasetId: 'ds-1',
        observedOwnerId: OWNER_ID,
        executionId: 'e1',
        selector: { kind: 'final_report' },
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
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'final_report' },
    });

    const call = mockedAppend.mock.calls[0][0] as { cases: Array<{ expectedOutput: string }> };
    expect(call.cases[0].expectedOutput).toContain('fallback result');
  });

  it('inputData is an array → wrapped as { input: [...] } (gap 13)', async () => {
    const arrayInput = ['item-a', 'item-b'];
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: arrayInput,
      outputData: null,
      executionTrace: [{ stepId: 's1', status: 'completed', output: 'result' }],
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'last_step' },
    });

    const passedCase = (mockedAppend.mock.calls[0][0] as { cases: Array<{ input: unknown }> })
      .cases[0];
    // Array input must be wrapped, not passed raw (raw would fail schema: arrays not allowed at top level)
    expect(passedCase.input).toEqual({ input: arrayInput });
  });

  it('inputData is null → wrapped as { input: null } (gap 14)', async () => {
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue({
      id: 'e1',
      workflowId: 'w1',
      status: 'completed',
      inputData: null,
      outputData: null,
      executionTrace: [{ stepId: 's1', status: 'completed', output: 'result' }],
    } as never);

    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-1',
      observedOwnerId: OWNER_ID,
      executionId: 'e1',
      selector: { kind: 'last_step' },
    });

    const passedCase = (mockedAppend.mock.calls[0][0] as { cases: Array<{ input: unknown }> })
      .cases[0];
    expect(passedCase.input).toEqual({ input: null });
  });
});

// ---------------------------------------------------------------------------
// resolveSelectorOutput — round-trip parity (gap 18)
// ---------------------------------------------------------------------------

describe('resolveSelectorOutput — round-trip parity with capture', () => {
  it('returns the same value captureWorkflowExecutionAsCase writes into expectedOutput', async () => {
    const execution = {
      id: 'e-rt',
      workflowId: 'w1',
      status: 'completed',
      inputData: { topic: 'parity' },
      outputData: null,
      executionTrace: [
        { stepId: 's1', status: 'completed', output: 'step one' },
        { stepId: 's2', status: 'completed', output: 'step two' },
      ],
    } as never as Parameters<typeof resolveSelectorOutput>[0];

    const selector = { kind: 'last_step' as const };

    // Call resolveSelectorOutput directly (the exported function the eval worker uses)
    const directResult = resolveSelectorOutput(execution, selector);

    // Simulate what captureWorkflowExecutionAsCase writes
    mockedPrisma.aiWorkflowExecution.findUnique.mockResolvedValue(execution as never);
    await captureWorkflowExecutionAsCase({
      datasetId: 'ds-rt',
      observedOwnerId: OWNER_ID,
      executionId: 'e-rt',
      selector,
    });

    const capturedExpectedOutput = (
      mockedAppend.mock.calls[0][0] as { cases: Array<{ expectedOutput: string }> }
    ).cases[0].expectedOutput;

    // The direct call and the capture must agree
    expect(directResult).toBe(capturedExpectedOutput);
    expect(directResult).toBe('step two');
  });
});
