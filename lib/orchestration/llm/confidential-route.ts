/**
 * Routing a turn that holds confidential content (§130 t-1038).
 *
 * A turn whose agent's provider a group's policy does not permit is answered
 * on the install's **model for confidential messages** instead, chosen at the
 * turn's start: by the time the privacy stage sees a call its provider and
 * model are fixed, and a fallback reuses the primary's model id, so the stage
 * can only refuse. One helper for the chat handler and the `agent_call` and
 * `chat_turn` executors, so each moves the same turns.
 *
 * The decision itself is the stage's ({@link confidentialRouting}): the same
 * policy, classifiers and per-group rule, so routing never moves a turn the
 * backstop would let through, nor keeps one it would refuse.
 *
 * @see .context/privacy/llm-privacy-layer.md § Confidential content
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import type { ResolvedAgentBinding } from '@/lib/orchestration/llm/agent-resolver';
import { confidentialRouting, type RoutingCandidate } from '@/lib/orchestration/llm/privacy-stage';
import { buildsLocalClient } from '@/lib/orchestration/llm/provider-locality';
import { isLocalProvider, isTrustedProvider } from '@/lib/orchestration/llm/provider-manager';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import type { ConfidentialModelBinding } from '@/types/orchestration';
import { isJsonObject } from '@/lib/privacy/config-recipients';
import {
  SENSITIVITY_GROUPS,
  type SensitivityGroup,
  type SensitivityPart,
} from '@/lib/privacy/adapters/types';

/** The conversation metadata key keeping the groups found in it (stickiness). */
const FLAGGED_KEY = 'confidentialFlagged';

/** What a turn does about confidential content, and the binding it answers on. */
export type ConfidentialRoute =
  /** Answered on the agent's binding; fallbacks a flagged group refuses are taken out. */
  | { kind: 'stay'; binding: ResolvedAgentBinding; found: SensitivityGroup[] }
  /** Answered on the model for confidential messages, with no fallbacks. */
  | {
      kind: 'move';
      binding: ResolvedAgentBinding;
      /** What the user is told the conversation moved to. */
      to: 'local' | 'trusted';
      found: SensitivityGroup[];
    }
  /** Needed moving, and no usable model was set: the backstop refuses it. */
  | { kind: 'unavailable'; binding: ResolvedAgentBinding; found: SensitivityGroup[] };

/** A message a turn will send, or a stored row of its history. */
export interface RoutingMessage {
  role: string;
  content: LlmMessage['content'];
}

const MESSAGE_ROLES = ['system', 'user', 'assistant', 'tool'] as const;

/** A candidate whose trust is looked up at most once, and only if a policy asks. */
function candidate(slug: string, isLocal: boolean): RoutingCandidate {
  let trusted: Promise<boolean> | undefined;
  return { slug, isLocal, isTrusted: () => (trusted ??= isTrustedProvider(slug)) };
}

/**
 * What the classifiers are given: each message's text with its role, as the
 * stage gives them a chat call's (`sensitivityParts`).
 */
export function routingParts(messages: readonly RoutingMessage[]): SensitivityPart[] {
  const parts: SensitivityPart[] = [];
  for (const m of messages) {
    const role = MESSAGE_ROLES.find((r) => r === m.role);
    // A stored row's role is a string; one that is no message role is not sent.
    if (role === undefined) continue;
    if (typeof m.content === 'string') {
      if (m.content.length > 0) parts.push({ role, text: m.content });
      continue;
    }
    for (const part of m.content) {
      if (part.type === 'text' && part.text.length > 0) {
        parts.push({ role, text: part.text });
      }
    }
  }
  return parts;
}

/**
 * Decide where a turn is answered. `messages` is what it will send, as far
 * as it is known before the request is built; `sticky` the groups found in
 * the conversation before ({@link readFlaggedGroups}). Never throws: a fault
 * keeps the agent's binding, and the stage decides each call as it would.
 */
export async function routeConfidentialTurn(input: {
  binding: ResolvedAgentBinding;
  messages: readonly RoutingMessage[];
  sticky?: readonly SensitivityGroup[];
  signal?: AbortSignal;
}): Promise<ConfidentialRoute> {
  const { binding } = input;
  try {
    const settings = await getOrchestrationSettings();
    const target = settings.confidentialModel;
    const [primaryLocal, fallbackLocal, targetLocal] = await Promise.all([
      isLocalProvider(binding.providerSlug),
      Promise.all(binding.fallbacks.map((slug) => isLocalProvider(slug))),
      target ? isLocalProvider(target.providerSlug) : Promise.resolve(false),
    ]);
    const targetCandidate = target ? candidate(target.providerSlug, targetLocal) : null;
    const routing = await confidentialRouting({
      parts: routingParts(input.messages),
      sticky: input.sticky ?? [],
      primary: candidate(binding.providerSlug, primaryLocal),
      fallbacks: binding.fallbacks.map((slug, i) => candidate(slug, fallbackLocal[i])),
      target: targetCandidate,
      settings,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const { found } = routing;
    // The policy permits the target; whether it can still answer is read
    // only now, when a turn would move to it: a provider turned off, or a
    // model no longer an active chat model, is no model at all.
    const unusable =
      routing.verdict === 'move' && target ? await confidentialModelProblem(target) : null;
    if (routing.verdict === 'move' && target && unusable === null) {
      return {
        kind: 'move',
        // The administrator's own choice, so gated as an explicit binding.
        // No fallbacks: a fallback is sent the primary's model id, which only
        // this provider is known to serve.
        binding: {
          providerSlug: target.providerSlug,
          model: target.model,
          fallbacks: [],
          provenance: {
            task: binding.provenance?.task ?? 'chat',
            primary: 'explicit',
            fallbacks: 'explicit',
          },
        },
        to: targetLocal ? 'local' : 'trusted',
        found,
      };
    }
    const kept = { ...binding, fallbacks: routing.fallbacks };
    if (routing.verdict !== 'stay') {
      logger.warn('privacy: a turn needed the model for confidential messages and none is usable', {
        provider: binding.providerSlug,
        confidentialModelSet: target !== null,
        ...(unusable !== null ? { problem: unusable } : {}),
      });
      return { kind: 'unavailable', binding: kept, found };
    }
    return { kind: 'stay', binding: kept, found };
  } catch (err) {
    logger.error('privacy: routing a turn for confidential content failed', err, {
      provider: binding.providerSlug,
    });
    return { kind: 'stay', binding, found: [] };
  }
}

/** The groups a conversation's metadata says were found in it before. */
export function readFlaggedGroups(metadata: Prisma.JsonValue | undefined): SensitivityGroup[] {
  if (!isJsonObject(metadata)) return [];
  const stored = metadata[FLAGGED_KEY];
  if (!Array.isArray(stored)) return [];
  return SENSITIVITY_GROUPS.filter((g) => stored.includes(g));
}

/**
 * Keep the groups a turn found on its conversation, so later turns stay on
 * the model for confidential messages once the message that held them has
 * been summarised or pruned away (a flagged conversation stays flagged). A
 * compare-and-set on the metadata as read, like the warn note's: a write made
 * in between is kept, and this one dropped, to be made again next turn.
 * Best effort: a failure is logged.
 */
export async function keepFlaggedGroups(
  where: Prisma.AiConversationWhereInput & { id: string },
  found: readonly SensitivityGroup[],
  /** The metadata the caller read with the conversation, so it is not read again. */
  stored?: Prisma.JsonValue | null
): Promise<void> {
  if (found.length === 0) return;
  try {
    const row =
      stored === undefined
        ? await prisma.aiConversation.findFirst({ where, select: { metadata: true } })
        : { metadata: stored };
    if (!row) return;
    const kept = readFlaggedGroups(row.metadata);
    if (found.every((g) => kept.includes(g))) return;
    const base = isJsonObject(row.metadata) ? row.metadata : {};
    await prisma.aiConversation.updateMany({
      where: {
        ...where,
        metadata: row.metadata === null ? { equals: Prisma.AnyNull } : { equals: row.metadata },
      },
      data: {
        metadata: {
          ...base,
          [FLAGGED_KEY]: SENSITIVITY_GROUPS.filter((g) => kept.includes(g) || found.includes(g)),
        },
      },
    });
  } catch (err) {
    logger.warn('privacy: could not keep the confidential groups found on the conversation', {
      conversationId: where.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Why `binding` cannot be the model for confidential messages, or null when
 * it can: an active chat model in the provider-model matrix, on an active
 * provider that is local or ticked "Trusted with confidential content". Read
 * from the database, so the settings API refuses a model that could never be
 * used, and config health can name one that stopped being usable.
 */
export async function confidentialModelProblem(
  binding: ConfidentialModelBinding
): Promise<string | null> {
  const [model, provider] = await Promise.all([
    prisma.aiProviderModel.findUnique({
      where: {
        providerSlug_modelId: { providerSlug: binding.providerSlug, modelId: binding.model },
      },
      select: { isActive: true, capabilities: true },
    }),
    prisma.aiProviderConfig.findUnique({
      where: { slug: binding.providerSlug },
      select: { isActive: true, isLocal: true, providerType: true, trustedForConfidential: true },
    }),
  ]);
  if (!provider) return 'Its provider is not configured.';
  if (!provider.isActive) return 'Its provider is turned off.';
  const local = buildsLocalClient(provider);
  if (!local && !provider.trustedForConfidential) {
    return 'Its provider is neither local nor ticked "Trusted with confidential content".';
  }
  if (!model) return 'The model is not in the provider models list.';
  if (!model.isActive) return 'The model is turned off in the provider models list.';
  if (!model.capabilities.includes('chat')) return 'The model is not a chat model.';
  return null;
}
