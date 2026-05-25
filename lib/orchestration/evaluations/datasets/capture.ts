/**
 * Trace-to-dataset capture.
 *
 * Two entry points convert real production traces into dataset cases:
 *
 *   - `captureConversationTurnAsCase(messageId, datasetId, edits?)` —
 *     pairs an assistant `AiMessage` with the immediately preceding
 *     user message and writes one case. The user message's `content`
 *     becomes `input`; the assistant's `content` becomes
 *     `expectedOutput` (the "the answer we'd want next time" semantic);
 *     `provenance.citations` maps to `referenceCitations`.
 *
 *   - `captureWorkflowExecutionAsCase(executionId, selector, datasetId, edits?)`
 *     reads an `AiWorkflowExecution`'s `executionTrace` (or its
 *     `outputData`/`finalReport`, depending on the selector) and writes
 *     one case keyed by the workflow's input vars. Selector mirrors
 *     `AiEvaluationRun.subjectOutputSelector` so the same selector
 *     wired through the runtime selector resolver is what the eval
 *     worker will replay against.
 *
 * Both helpers DO NOT enforce ownership — the caller (route layer)
 * must authenticate the requesting user against the dataset, the
 * conversation/execution, and the message/step ids before invoking
 * them. The helpers verify the relationships *between* those ids
 * (assistant must belong to the same conversation as the user message
 * before it, step id must exist in the execution trace).
 *
 * `edits` lets the admin override the captured fields before saving —
 * the form preview lets them tweak the input, expected output, or
 * citations without having to re-edit the source row. Edits only
 * override the keys they touch; everything else falls back to the
 * captured value.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { appendCasesToDataset } from '@/lib/orchestration/evaluations/datasets/append-cases';

export interface CaptureCaseEdits {
  /** Override the captured `input` (the prompt the eval will replay). */
  input?: string | Record<string, unknown>;
  /** Override the captured `expectedOutput` (the "right answer" snapshot). */
  expectedOutput?: string;
  /** Override the captured `referenceCitations` array. */
  referenceCitations?: unknown[];
  /** Merge into the captured `metadata` (does not replace existing keys). */
  metadataPatch?: Record<string, unknown>;
}

export interface CaptureResult {
  datasetId: string;
  appendedCount: number;
  newCaseCount: number;
}

// ---------------------------------------------------------------------------
// Conversation turn → dataset case
// ---------------------------------------------------------------------------

export async function captureConversationTurnAsCase(params: {
  datasetId: string;
  messageId: string;
  edits?: CaptureCaseEdits;
}): Promise<CaptureResult> {
  const { datasetId, messageId, edits } = params;

  const assistant = await prisma.aiMessage.findUnique({
    where: { id: messageId },
    select: {
      id: true,
      role: true,
      content: true,
      provenance: true,
      conversationId: true,
      createdAt: true,
      conversation: { select: { id: true, agentId: true, contextType: true } },
    },
  });
  if (!assistant) {
    throw new NotFoundError(`Message ${messageId} not found`);
  }
  if (assistant.role !== 'assistant') {
    throw new ValidationError(
      `Message ${messageId} is role='${assistant.role}'; capture requires an assistant turn so the answer becomes expectedOutput.`
    );
  }

  // Find the immediately preceding user message in the same conversation.
  // We pair on createdAt rather than position because AiMessage doesn't
  // carry a position column.
  const userMessage = await prisma.aiMessage.findFirst({
    where: {
      conversationId: assistant.conversationId,
      role: 'user',
      createdAt: { lt: assistant.createdAt },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, content: true, createdAt: true },
  });
  if (!userMessage) {
    throw new ValidationError(
      `Assistant message ${messageId} has no preceding user turn in the same conversation — nothing to capture as input.`
    );
  }

  const provenance = (assistant.provenance ?? {}) as { citations?: unknown };
  const capturedCitations = Array.isArray(provenance.citations) ? provenance.citations : undefined;

  const capturedInput = userMessage.content;
  const capturedExpectedOutput = assistant.content;
  const capturedMetadata: Record<string, unknown> = {
    source: 'conversation_capture',
    conversationId: assistant.conversationId,
    sourceMessageId: assistant.id,
    sourceUserMessageId: userMessage.id,
    agentId: assistant.conversation.agentId,
    capturedAt: new Date().toISOString(),
  };

  const finalCase = applyEdits(
    {
      input: capturedInput,
      expectedOutput: capturedExpectedOutput,
      referenceCitations: capturedCitations,
      metadata: capturedMetadata,
    },
    edits
  );

  const result = await appendCasesToDataset({
    datasetId,
    cases: [finalCase],
    source: 'conversation_capture',
  });

  logger.info('Captured conversation turn as dataset case', {
    datasetId,
    sourceMessageId: assistant.id,
    sourceConversationId: assistant.conversationId,
    newCaseCount: result.newCaseCount,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Workflow execution → dataset case
// ---------------------------------------------------------------------------

export interface WorkflowSubjectOutputSelector {
  kind: 'final_report' | 'last_step' | 'step_id';
  stepId?: string;
}

interface ExecutionTraceEntry {
  stepId?: string;
  status?: string;
  output?: unknown;
}

export async function captureWorkflowExecutionAsCase(params: {
  datasetId: string;
  executionId: string;
  selector: WorkflowSubjectOutputSelector;
  edits?: CaptureCaseEdits;
}): Promise<CaptureResult> {
  const { datasetId, executionId, selector, edits } = params;

  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id: executionId },
    select: {
      id: true,
      workflowId: true,
      status: true,
      inputData: true,
      outputData: true,
      executionTrace: true,
    },
  });
  if (!execution) {
    throw new NotFoundError(`Workflow execution ${executionId} not found`);
  }
  if (execution.status !== 'completed') {
    throw new ValidationError(
      `Execution ${executionId} is status='${execution.status}'; only completed runs can be captured as cases.`
    );
  }

  const inputData =
    execution.inputData &&
    typeof execution.inputData === 'object' &&
    !Array.isArray(execution.inputData)
      ? (execution.inputData as Record<string, unknown>)
      : { input: execution.inputData };

  const capturedExpectedOutput = resolveSelectorOutput(execution, selector);
  if (capturedExpectedOutput === null) {
    throw new ValidationError(
      `Selector ${selector.kind}${selector.stepId ? `:${selector.stepId}` : ''} did not resolve to any output on execution ${executionId}.`
    );
  }

  const capturedMetadata: Record<string, unknown> = {
    source: 'workflow_capture',
    workflowId: execution.workflowId,
    sourceExecutionId: execution.id,
    selector,
    capturedAt: new Date().toISOString(),
  };

  const finalCase = applyEdits(
    {
      input: inputData,
      expectedOutput: capturedExpectedOutput,
      metadata: capturedMetadata,
    },
    edits
  );

  const result = await appendCasesToDataset({
    datasetId,
    cases: [finalCase],
    source: 'workflow_capture',
  });

  logger.info('Captured workflow execution as dataset case', {
    datasetId,
    sourceExecutionId: execution.id,
    selector,
    newCaseCount: result.newCaseCount,
  });

  return result;
}

/**
 * Resolve a `subjectOutputSelector` against a completed execution.
 * Matches the runtime selector contract; returns the resolved string or
 * `null` when nothing matched. Object outputs are JSON-stringified so
 * the dataset case's `expectedOutput` is always a string.
 */
function resolveSelectorOutput(
  execution: { outputData: unknown; executionTrace: unknown },
  selector: WorkflowSubjectOutputSelector
): string | null {
  if (selector.kind === 'final_report') {
    // Pick the last completed `report`-typed step from the trace; fall
    // back to the execution's outputData when no report step ran.
    const trace = Array.isArray(execution.executionTrace)
      ? (execution.executionTrace as Array<ExecutionTraceEntry & { stepType?: string }>)
      : null;
    if (trace) {
      const report = [...trace]
        .reverse()
        .find((e) => e.status === 'completed' && e.stepType === 'report');
      if (report && report.output !== undefined && report.output !== null) {
        return typeof report.output === 'string' ? report.output : JSON.stringify(report.output);
      }
    }
    const fallback = execution.outputData;
    if (typeof fallback === 'string' && fallback.length > 0) return fallback;
    if (fallback !== null && fallback !== undefined) return JSON.stringify(fallback);
    return null;
  }
  if (selector.kind === 'step_id') {
    if (!selector.stepId) return null;
    const trace = Array.isArray(execution.executionTrace)
      ? (execution.executionTrace as ExecutionTraceEntry[])
      : null;
    if (!trace) return null;
    const completed = trace
      .filter((e) => e.stepId === selector.stepId && e.status === 'completed')
      .pop();
    if (!completed || completed.output === undefined || completed.output === null) return null;
    return typeof completed.output === 'string'
      ? completed.output
      : JSON.stringify(completed.output);
  }
  // 'last_step' — last completed entry in the trace
  const trace = Array.isArray(execution.executionTrace)
    ? (execution.executionTrace as ExecutionTraceEntry[])
    : null;
  if (trace) {
    const lastCompleted = [...trace].reverse().find((e) => e.status === 'completed');
    if (lastCompleted && lastCompleted.output !== undefined && lastCompleted.output !== null) {
      return typeof lastCompleted.output === 'string'
        ? lastCompleted.output
        : JSON.stringify(lastCompleted.output);
    }
  }
  // Fall back to the execution's outputData when the trace doesn't have
  // a usable last entry (e.g. trace was pruned).
  const fallback = execution.outputData;
  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  if (fallback !== null && fallback !== undefined) return JSON.stringify(fallback);
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface CapturedCase {
  input: string | Record<string, unknown>;
  expectedOutput?: string;
  referenceCitations?: unknown[];
  metadata: Record<string, unknown>;
}

function applyEdits(
  captured: CapturedCase,
  edits: CaptureCaseEdits | undefined
): {
  input: string | Record<string, unknown>;
  expectedOutput?: string;
  metadata: Record<string, unknown>;
  referenceCitations?: unknown[];
} {
  const next = {
    input: edits?.input ?? captured.input,
    expectedOutput:
      edits?.expectedOutput !== undefined ? edits.expectedOutput : captured.expectedOutput,
    metadata: edits?.metadataPatch
      ? { ...captured.metadata, ...edits.metadataPatch }
      : captured.metadata,
    referenceCitations:
      edits?.referenceCitations !== undefined
        ? edits.referenceCitations
        : captured.referenceCitations,
  };

  // Drop optional empty arrays so the case schema's `optional()` check
  // is happy. `appendCasesToDataset` re-validates via Zod anyway, but a
  // pre-clean keeps the wire shape consistent with `uploadDataset`.
  const out: ReturnType<typeof applyEdits> = {
    input: next.input,
    metadata: next.metadata,
  };
  if (next.expectedOutput !== undefined) out.expectedOutput = next.expectedOutput;
  if (next.referenceCitations !== undefined && next.referenceCitations.length > 0) {
    out.referenceCitations = next.referenceCitations;
  }
  return out;
}
