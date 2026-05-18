/**
 * Escalate to Human capability
 *
 * Allows an agent to signal that a conversation needs human attention.
 * Dispatches a `conversation_escalated` webhook event so external
 * systems (helpdesks, ticketing, Slack) can pick up the escalation.
 *
 * The agent remains in the conversation — the escalation is a signal,
 * not a hard transfer. The agent should inform the user that a human
 * will follow up.
 */

import { z } from 'zod';
import { logger } from '@/lib/logging';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { notifyEscalation } from '@/lib/orchestration/capabilities/built-in/escalation-notifier';
import { BaseCapability } from '@/lib/orchestration/capabilities/base-capability';
import type {
  CapabilityContext,
  CapabilityFunctionDefinition,
  CapabilityResult,
} from '@/lib/orchestration/capabilities/types';
import { redactedString } from '@/lib/security/redact';

const schema = z.object({
  reason: z.string().min(1).max(1000),
  priority: z.enum(['low', 'medium', 'high']).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

type Args = z.infer<typeof schema>;

interface Data {
  escalated: true;
  reason: string;
  priority: 'low' | 'medium' | 'high';
}

export class EscalateToHumanCapability extends BaseCapability<Args, Data> {
  readonly slug = 'escalate_to_human';
  readonly processesPii = true;

  /**
   * `reason` is free-text the LLM constructs from conversation context
   * — almost certain to contain PII (names, account refs, complaint
   * details). `metadata` is unstructured user context, same risk.
   *
   * The audit row keeps `priority` and the length of `reason` (a
   * useful integrity check), plus a sentinel marking that escalation
   * fired. The escalation itself still propagates the un-redacted
   * payload to webhook subscribers and the notifier — those surfaces
   * have their own access controls.
   */
  redactProvenance(
    args: Args,
    result: CapabilityResult<Data>
  ): {
    args: unknown;
    resultPreview: string;
  } {
    const safeArgs = {
      reason: redactedString(`free-text, ${args.reason.length} chars`),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.metadata !== undefined ? { metadata: redactedString('user-context') } : {}),
    };
    // Result envelope echoes `reason` — drop it from the preview too.
    if (result.success && result.data) {
      const safeData = {
        escalated: result.data.escalated,
        reason: redactedString(`free-text, ${result.data.reason.length} chars`),
        priority: result.data.priority,
      };
      return {
        args: safeArgs,
        resultPreview: JSON.stringify({ success: true, data: safeData }),
      };
    }
    return { args: safeArgs, resultPreview: JSON.stringify(result) };
  }

  readonly functionDefinition: CapabilityFunctionDefinition = {
    name: 'escalate_to_human',
    description:
      'Signal that this conversation needs human attention. Use when you cannot adequately help the user, the request is outside your capabilities, or the user explicitly asks for a human.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why the conversation is being escalated (visible to the human agent).',
          minLength: 1,
          maxLength: 1000,
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Urgency level. Defaults to medium.',
        },
        metadata: {
          type: 'object',
          description:
            'Optional structured data to pass to the human agent (e.g. extracted ticket info, user context).',
        },
      },
      required: ['reason'],
    },
  };

  protected readonly schema = schema;

  execute(args: Args, context: CapabilityContext): Promise<CapabilityResult<Data>> {
    const { reason, metadata } = args;
    const priority = args.priority ?? 'medium';

    logger.info('Escalation triggered', {
      agentId: context.agentId,
      userId: context.userId,
      conversationId: context.conversationId,
      priority,
    });

    const escalationPayload = {
      agentId: context.agentId,
      userId: context.userId,
      conversationId: context.conversationId ?? null,
      reason,
      priority,
      metadata: metadata ?? null,
    };

    void dispatchWebhookEvent('conversation_escalated', escalationPayload);

    void notifyEscalation(escalationPayload);

    return Promise.resolve(
      this.success({
        escalated: true,
        reason,
        priority,
      })
    );
  }
}
