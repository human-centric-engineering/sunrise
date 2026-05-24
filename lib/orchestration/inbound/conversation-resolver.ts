/**
 * Find-or-create the `AiConversation` row for an inbound message.
 *
 * Called from the inbound route handler after `verify` + `normalise`,
 * but only when the adapter set the conversation-key fields
 * (`conversationChannel`, `conversationProvider`, `fromAddress`).
 * Slack / generic-HMAC inbound traffic flows through the engine without
 * conversation enrichment — there's no end-user address to key on.
 *
 * Conversation key: `(agentId, channel, fromAddress)` — deliberately
 * EXCLUDES provider. A partner that swaps SMS providers (Twilio →
 * Vonage) retains the existing conversation row; only the `provider`
 * column updates so subsequent outbound dispatch reaches the new vendor.
 * Memory continuity, opt-out flag, and citation history all survive
 * the provider swap.
 *
 * STOP / START handling: runs `detectStopIntent` on every inbound text.
 * A `stop` flips `smsOptedOut = true` (with audit log); a `start` flips
 * it back to `false`. `help` is informational and changes nothing.
 *
 * The resolver is the only place that updates `smsOptedOut`. The
 * outbound capability reads it as a refusal gate; the inbound side
 * never sends an outbound — the agent / workflow chooses whether to.
 */

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { detectStopIntent } from '@/lib/orchestration/inbound/stop-keywords';
import type { ConversationChannel } from '@/lib/orchestration/inbound/types';

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export interface ResolveConversationArgs {
  agentId: string;
  userId: string;
  channel: ConversationChannel;
  provider: string;
  fromAddress: string;
  /** Inbound message text, used for STOP / START detection. */
  text: string | null | undefined;
  /** Optional inbound trigger title for first-creation `title` seed. */
  conversationTitle?: string;
}

export interface ResolveConversationResult {
  conversationId: string;
  wasCreated: boolean;
  optOutStateChanged: boolean;
}

/**
 * Find-or-create the conversation row for an inbound message, update
 * `lastInboundAt`, and reconcile the `smsOptedOut` flag from STOP /
 * START intent in the message body.
 *
 * Returns `{ conversationId, wasCreated, optOutStateChanged }` so the
 * caller can wire the conversation id into the workflow execution's
 * input data and decide whether to short-circuit the workflow on an
 * opt-out (recommended: still execute, but the workflow can branch on
 * `triggerMeta.optOutStateChanged`).
 */
export async function resolveConversation(
  args: ResolveConversationArgs
): Promise<ResolveConversationResult> {
  const stopIntent = detectStopIntent(args.text);
  const optOutChange = stopIntent === 'stop' ? true : stopIntent === 'start' ? false : null;

  // Lookup keyed on the @@unique([agentId, channel, fromAddress]) defined
  // on AiConversation. Two concurrent inbound webhooks for the same sender
  // race here: the loser hits P2002 on the create below and re-reads.
  const lookup = {
    ai_conversation_inbound_key: {
      agentId: args.agentId,
      channel: args.channel,
      fromAddress: args.fromAddress,
    },
  };

  let existing = await prisma.aiConversation.findUnique({
    where: lookup,
    select: { id: true, smsOptedOut: true, provider: true },
  });

  if (!existing) {
    // No row yet — try create. New users who open with STOP start opted-out
    // immediately (regulatory: honour the very first signal); START starts
    // opted-in (which is the column default anyway).
    try {
      const created = await prisma.aiConversation.create({
        data: {
          userId: args.userId,
          agentId: args.agentId,
          channel: args.channel,
          provider: args.provider,
          fromAddress: args.fromAddress,
          lastInboundAt: new Date(),
          smsOptedOut: optOutChange === true,
          title: args.conversationTitle ?? `${args.channel}:${args.fromAddress}`,
        },
        select: { id: true },
      });
      return {
        conversationId: created.id,
        wasCreated: true,
        optOutStateChanged: optOutChange === true,
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Race: a concurrent inbound created the row between our findUnique
      // and create. Re-fetch and fall through to the existing-row branch.
      existing = await prisma.aiConversation.findUnique({
        where: lookup,
        select: { id: true, smsOptedOut: true, provider: true },
      });
      if (!existing) throw err;
    }
  }

  const updates: Record<string, unknown> = { lastInboundAt: new Date() };
  if (existing.provider !== args.provider) {
    // Provider swap (e.g. Twilio SMS → Vonage SMS for the same end user).
    // Keep the conversation; update the provider so outbound goes through
    // the new vendor on the next reply.
    updates.provider = args.provider;
  }
  let optOutStateChanged = false;
  if (optOutChange !== null && existing.smsOptedOut !== optOutChange) {
    updates.smsOptedOut = optOutChange;
    optOutStateChanged = true;
  }
  await prisma.aiConversation.update({
    where: { id: existing.id },
    data: updates,
  });

  if (optOutStateChanged) {
    try {
      logAdminAction({
        action: optOutChange ? 'inbound.opt_out_recorded' : 'inbound.opt_in_recorded',
        entityType: 'ai_conversation',
        entityId: existing.id,
        userId: args.userId,
        metadata: {
          channel: args.channel,
          provider: args.provider,
          source: 'inbound-stop-keyword',
        },
      });
    } catch (err) {
      logger.warn('conversation-resolver: failed to write opt-state audit log', {
        conversationId: existing.id,
        logError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    conversationId: existing.id,
    wasCreated: false,
    optOutStateChanged,
  };
}
