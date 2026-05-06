/**
 * `run_workflow` capability
 *
 * Lets an agent trigger a named workflow on the user's behalf during a
 * chat turn. The workflow may complete synchronously (in which case the
 * LLM gets the output as a normal tool result) or pause on a
 * `human_approval` step — at which point the capability returns
 * structured pending-approval data and sets `skipFollowup: true` so the
 * chat handler can emit an `approval_required` SSE event without the
 * LLM narrating an intermediate "I've started a workflow…" turn. The
 * user clicks Approve / Reject in-chat, the existing public token
 * endpoints process the decision, and the chat client polls the
 * execution row to a terminal state and submits a follow-up message
 * carrying the workflow output.
 *
 * Per-agent binding (`AiAgentCapability.customConfig`):
 *   - `allowedWorkflowSlugs: string[]` — required, min 1. The LLM may
 *     only invoke workflows on this list. Fail-closed if missing.
 *   - `defaultBudgetUsd?: number` — optional. Forwarded to the engine
 *     as `budgetLimitUsd` so chat-triggered workflows can't exceed a
 *     per-binding spend cap regardless of system prompt.
 *
 * Token shape: the capability returns raw HMAC `approveToken` /
 * `rejectToken` strings rather than fully-built URLs. The client
 * (admin chat card or embed widget) constructs the final URL pointing
 * at its channel-specific sub-route (`/approve/chat`, `/approve/embed`)
 * at POST time. This keeps the capability channel-agnostic and the
 * persisted message metadata stable across future surfaces (MCP, CLI,
 * etc).
 */

import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { generateApprovalToken } from '@/lib/orchestration/approval-tokens';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import type { WorkflowDefinition } from '@/types/orchestration';

const customConfigSchema = z
  .object({
    /**
     * Whitelist of workflow slugs this binding may invoke. The LLM
     * passes a slug and we check membership here — never trust LLM
     * output to constrain itself.
     */
    allowedWorkflowSlugs: z.array(z.string().min(1).max(120)).min(1),
    /**
     * Hard cap on workflow spend (USD). Forwarded to the engine; null
     * / undefined leaves the budget unconstrained at this layer (the
     * engine still respects its own defaults and global settings).
     */
    defaultBudgetUsd: z.number().positive().optional(),
  })
  .strict();

type CustomConfig = z.infer<typeof customConfigSchema>;

const argsSchema = z.object({
  workflowSlug: z.string().min(1).max(120),
  input: z.record(z.string(), z.unknown()).optional(),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Discriminated by `status`. The chat streaming handler narrows on
 * `pending_approval` to emit the `approval_required` SSE event and
 * persist the marker on the assistant message metadata. Workflow
 * failure is surfaced as a capability error (not a Data variant) so
 * the LLM treats it as a tool failure rather than a sad-path success.
 */
type Data =
  | {
      status: 'completed';
      executionId: string;
      output: unknown;
      totalCostUsd: number;
      totalTokensUsed: number;
    }
  | {
      status: 'pending_approval';
      executionId: string;
      stepId: string;
      prompt: string;
      expiresAt: string;
      approveToken: string;
      rejectToken: string;
    };

const SLUG = 'run_workflow';

export class RunWorkflowCapability extends BaseCapability<Args, Data> {
  readonly slug = SLUG;

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: SLUG,
    description:
      'Run a named workflow on behalf of the user. Use this for actions that require a multi-step pipeline, an approval gate, or capabilities not directly bound to this agent. The workflow may pause for human approval — when that happens, the user is shown an Approve / Reject card in the chat and the run continues only after they click. Returns when the workflow either completes (you receive the output) or pauses for approval (you receive a pending status; do not narrate further until the user replies).',
    parameters: {
      type: 'object',
      properties: {
        workflowSlug: {
          type: 'string',
          description:
            'Slug of the workflow to run. Must be one of the workflows the admin has authorised this agent to invoke.',
          maxLength: 120,
        },
        input: {
          type: 'object',
          description:
            "Input data passed to the workflow's entry step. Shape is defined by the workflow's expected input schema.",
          additionalProperties: true,
        },
      },
      required: ['workflowSlug'],
    },
  };

  protected readonly schema = argsSchema;

  async execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const loaded = await this.loadCustomConfig(context.agentId);
    if (loaded.kind === 'malformed') {
      logger.error('run_workflow: refusing call — customConfig JSON is malformed', {
        agentId: context.agentId,
        issues: loaded.issues,
      });
      return this.error(
        'Capability binding is misconfigured — admin must repair the customConfig JSON',
        'invalid_binding'
      );
    }
    const customConfig = loaded.config;

    if (!customConfig) {
      return this.error(
        'No allowedWorkflowSlugs configured for this binding — admin must set customConfig.allowedWorkflowSlugs',
        'invalid_binding'
      );
    }
    if (!customConfig.allowedWorkflowSlugs.includes(args.workflowSlug)) {
      return this.error(
        `Workflow not allowed by binding: must be one of ${customConfig.allowedWorkflowSlugs.join(', ')}`,
        'workflow_not_allowed'
      );
    }

    const workflowRow = await prisma.aiWorkflow.findFirst({
      where: { slug: args.workflowSlug, isActive: true },
      select: {
        id: true,
        slug: true,
        publishedVersion: { select: { id: true, snapshot: true } },
      },
    });
    if (!workflowRow) {
      return this.error(
        `Workflow ${args.workflowSlug} not found or not active`,
        'workflow_not_found'
      );
    }
    if (!workflowRow.publishedVersion) {
      return this.error(
        `Workflow ${args.workflowSlug} has no published version`,
        'workflow_not_published'
      );
    }

    const definitionParsed = workflowDefinitionSchema.safeParse(
      workflowRow.publishedVersion.snapshot
    );
    if (!definitionParsed.success) {
      logger.error('run_workflow: workflow definition failed validation', {
        agentId: context.agentId,
        workflowSlug: args.workflowSlug,
        issues: definitionParsed.error.issues,
      });
      return this.error(
        `Workflow ${args.workflowSlug} has a malformed definition`,
        'workflow_malformed'
      );
    }
    const definition = definitionParsed.data as WorkflowDefinition;
    const pinnedVersionId = workflowRow.publishedVersion.id;

    const engine = new OrchestrationEngine();

    let executionId: string | undefined;
    let result: Data | undefined;
    let failure: { error: string; failedStepId?: string } | undefined;

    try {
      for await (const event of engine.execute(
        { id: workflowRow.id, definition, versionId: pinnedVersionId },
        args.input ?? {},
        {
          userId: context.userId,
          ...(customConfig.defaultBudgetUsd !== undefined
            ? { budgetLimitUsd: customConfig.defaultBudgetUsd }
            : {}),
        }
      )) {
        if (event.type === 'workflow_started') {
          executionId = event.executionId;
        } else if (event.type === 'workflow_completed' && executionId) {
          result = {
            status: 'completed',
            executionId,
            output: event.output,
            totalCostUsd: event.totalCostUsd,
            totalTokensUsed: event.totalTokensUsed,
          };
        } else if (event.type === 'workflow_failed') {
          failure = {
            error: event.error,
            ...(event.failedStepId ? { failedStepId: event.failedStepId } : {}),
          };
        } else if (event.type === 'approval_required' && executionId) {
          result = this.buildPendingApproval(executionId, event.stepId, event.payload, definition);
        }
      }
    } catch (err) {
      logger.error('run_workflow: engine threw during execute', {
        agentId: context.agentId,
        workflowSlug: args.workflowSlug,
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return this.error(
        err instanceof Error ? err.message : 'Workflow execution failed',
        'workflow_dispatch_failed'
      );
    }

    if (failure) {
      const idPart = executionId ? ` (execution ${executionId})` : '';
      const stepPart = failure.failedStepId ? ` at step ${failure.failedStepId}` : '';
      return this.error(
        `Workflow ${args.workflowSlug}${idPart} failed${stepPart}: ${failure.error}`,
        'workflow_failed'
      );
    }

    if (!result) {
      logger.error('run_workflow: engine drained without a terminal event', {
        agentId: context.agentId,
        workflowSlug: args.workflowSlug,
        executionId,
      });
      return this.error(
        'Workflow execution ended without a terminal event',
        'workflow_no_terminal'
      );
    }

    // `pending_approval` does not feed back to the LLM — the user acts
    // next, not the model. `completed` goes back as a normal tool
    // result so the LLM can summarise the outcome for the user.
    if (result.status === 'pending_approval') {
      return this.success(result, { skipFollowup: true });
    }
    return this.success(result);
  }

  private buildPendingApproval(
    executionId: string,
    stepId: string,
    payload: unknown,
    definition: WorkflowDefinition
  ): Data {
    const stepConfig =
      typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const promptFromPayload = typeof stepConfig.prompt === 'string' ? stepConfig.prompt : null;
    const promptFromDefinition =
      definition.steps.find((s) => s.id === stepId)?.config?.prompt ?? null;
    const prompt =
      promptFromPayload ??
      (typeof promptFromDefinition === 'string' ? promptFromDefinition : 'Approval required');

    const rawTimeout = stepConfig.timeoutMinutes;
    const timeoutMinutes = typeof rawTimeout === 'number' ? rawTimeout : undefined;

    const approve = generateApprovalToken(executionId, 'approve', timeoutMinutes);
    const reject = generateApprovalToken(executionId, 'reject', timeoutMinutes);

    return {
      status: 'pending_approval',
      executionId,
      stepId,
      prompt,
      expiresAt: approve.expiresAt.toISOString(),
      approveToken: approve.token,
      rejectToken: reject.token,
    };
  }

  private async loadCustomConfig(agentId: string): Promise<LoadCustomConfigResult> {
    const binding = await prisma.aiAgentCapability.findFirst({
      where: { agentId, capability: { slug: SLUG } },
      select: { customConfig: true },
    });
    if (!binding?.customConfig) return { kind: 'ok', config: undefined };

    const parsed = customConfigSchema.safeParse(binding.customConfig);
    if (!parsed.success) {
      return { kind: 'malformed', issues: parsed.error.issues };
    }
    return { kind: 'ok', config: parsed.data };
  }
}

type LoadCustomConfigResult =
  | { kind: 'ok'; config: CustomConfig | undefined }
  | { kind: 'malformed'; issues: ReadonlyArray<unknown> };

export const __testing = { customConfigSchema, argsSchema };
