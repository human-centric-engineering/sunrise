/**
 * `send_notification` — Send email or webhook notifications from a workflow.
 *
 * Config:
 *   - `channel: 'email' | 'webhook'` — notification channel.
 *   - `to: string | string[]` — recipients (email addresses or webhook URL).
 *   - `subject?: string` — email subject (required for email channel).
 *   - `bodyTemplate: string` — message body with `{{input}}` interpolation.
 *   - `webhookUrl?: string` — target URL (required for webhook channel).
 *
 * Supports `{{input}}` and `{{steps.<stepId>.output}}` template variables.
 */

import { z } from 'zod';
import type { StepResult, WorkflowStep } from '@/types/orchestration';
import type { ExecutionContext } from '@/lib/orchestration/engine/context';
import { ExecutorError } from '@/lib/orchestration/engine/errors';
import { interpolatePrompt } from '@/lib/orchestration/engine/llm-runner';
import { registerStepType } from '@/lib/orchestration/engine/executor-registry';
import { sendEmail } from '@/lib/email/send';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { logger } from '@/lib/logging';
import { WorkflowNotification } from '@/emails/workflow-notification';

// ─── Config schema ──────────────────────────────────────────────────────────

const notificationConfigSchema = z.discriminatedUnion('channel', [
  z.object({
    channel: z.literal('email'),
    to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
    subject: z.string().min(1).max(200),
    bodyTemplate: z.string().min(1).max(10_000),
  }),
  z.object({
    channel: z.literal('webhook'),
    webhookUrl: z.string().url(),
    bodyTemplate: z.string().min(1).max(10_000),
  }),
]);

// ─── Executor ───────────────────────────────────────────────────────────────

async function executeNotification(
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
): Promise<StepResult> {
  const parsed = notificationConfigSchema.safeParse(step.config);
  if (!parsed.success) {
    throw new ExecutorError(
      step.id,
      'INVALID_CONFIG',
      `Invalid notification config: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }

  const config = parsed.data;
  const body = interpolatePrompt(config.bodyTemplate, ctx, step.id);
  const workflowName = (ctx.variables.workflowName as string) ?? 'Workflow';

  if (config.channel === 'email') {
    try {
      const result = await sendEmail({
        to: config.to,
        subject: interpolatePrompt(config.subject, ctx, step.id),
        react: WorkflowNotification({ body, workflowName }),
      });

      if (result.status === 'failed') {
        throw new ExecutorError(
          step.id,
          'EMAIL_SEND_FAILED',
          `Email send failed: ${result.error}`,
          undefined,
          true
        );
      }

      logger.info('Notification step: email sent', {
        stepId: step.id,
        to: config.to,
        status: result.status,
      });

      return {
        output: { sent: true, channel: 'email', status: result.status },
        tokensUsed: 0,
        costUsd: 0,
      };
    } catch (err) {
      if (err instanceof ExecutorError) throw err;
      throw new ExecutorError(
        step.id,
        'EMAIL_DELIVERY_ERROR',
        `Email delivery error: ${err instanceof Error ? err.message : String(err)}`,
        err,
        true
      );
    }
  }

  // Webhook channel
  try {
    await dispatchWebhookEvent('workflow_notification', {
      webhookUrl: config.webhookUrl,
      body,
      workflowId: ctx.workflowId,
      workflowName,
      executionId: ctx.executionId,
      stepId: step.id,
    });

    logger.info('Notification step: webhook dispatched', {
      stepId: step.id,
      webhookUrl: config.webhookUrl,
    });

    return {
      output: { sent: true, channel: 'webhook', url: config.webhookUrl },
      tokensUsed: 0,
      costUsd: 0,
    };
  } catch (err) {
    throw new ExecutorError(
      step.id,
      'WEBHOOK_DISPATCH_ERROR',
      `Webhook dispatch error: ${err instanceof Error ? err.message : String(err)}`,
      err,
      true
    );
  }
}

registerStepType('send_notification', executeNotification);
