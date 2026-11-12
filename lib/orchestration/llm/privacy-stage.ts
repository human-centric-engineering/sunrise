/**
 * The LLM privacy stage: what the provider-manager Proxy runs on every
 * protected vendor call, after the eligibility and spend gates (§127).
 *
 * It resolves the call's policy, scans what the call would send with every
 * registered detector, records per-type counts (never values) in the call's
 * privacy scope and tells the observers, then acts per mode:
 *
 * - `off`, `detect` — the arguments go out unchanged.
 * - `pseudonymise` — found values are replaced by placeholders, and the
 *   returned {@link CallRestorer} puts them back in the reply and in tool-call
 *   arguments before the caller sees them (t-992).
 * - `redact` — replaced, never restored.
 * - `block` — a chat call with anything found is refused.
 *
 * Embedding calls are counted and never altered, whatever the mode; under
 * `embeddingsPolicy: local_only` and a masking mode, one to a provider that is
 * not `isLocal` is refused instead.
 *
 * It refuses, and never sends, when it cannot say what the policy is: a
 * failed app init or core install (mode `off` included, because what was
 * rolled back may be what raised it), an unreadable stored mode, a policy
 * resolver that failed, or a bug in the stage itself. The opposite of the
 * guard-floor seams, on purpose. Under a masking mode it also refuses when a
 * required detector failed, rather than send the call part-masked (owner
 * ruling, 2026-11-11).
 *
 * Nothing here logs request text or a found value.
 *
 * @see .context/privacy/llm-privacy-layer.md — *How a call flows*, *When an adapter fails*
 */
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logging';
import { PRIVACY_BLOCKED, PRIVACY_REFUSED, ProviderError } from '@/lib/orchestration/llm/provider';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  CallRestorer,
  maskMessages,
  messagePieces,
  messagesHoldingSpans,
  PIECE_SEPARATOR,
  withPlaceholderInstruction,
} from '@/lib/orchestration/privacy/call-masking';
import {
  createPrivacyScope,
  currentPrivacyScope,
  knownValuesOf,
  recordPrivacyCall,
  recordPrivacyRefusal,
  recordPrivacyUnresolved,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import { scopePrivacySettings } from '@/lib/orchestration/privacy/scope-settings';
import {
  basePolicyFromSettings,
  isMaskingMode,
  protectsContent,
} from '@/lib/orchestration/privacy/settings-policy';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { getPrivacyAdapters } from '@/lib/privacy/adapters/registry';
import {
  notifyPrivacyObservers,
  resolvePrivacyPolicy,
  runPrivacyDetectors,
} from '@/lib/privacy/adapters/run';
import type { EntityType, PrivacyEvent, PrivacyPolicy } from '@/lib/privacy/adapters/types';
import { orgIdForCall } from '@/lib/tenancy/context';

/**
 * How long the whole detection pass may take. Each detector has its own
 * timeout as well; this bounds the sum, and the detectors left when it fires
 * are reported `aborted`.
 */
export const PRIVACY_PASS_DEADLINE_MS = 5_000;

/**
 * What the stage does to a method.
 *
 * - `full` — scanned and acted on per mode (`chat`, `chatStream`).
 * - `count` — scanned and counted, never altered (`embed`, `embedMany`):
 *   masking an embedding input breaks search by name (spec § Embeddings).
 * - `none` — not covered (`transcribe`: audio cannot be masked; admin metadata
 *   calls that send no user content).
 */
export type PrivacyCoverage = 'full' | 'count' | 'none';

/** Why the stage refused a call. Shown to the admin; never contains request text. */
export type PrivacyRefusalReason =
  | 'app_init_failed'
  | 'core_install_failed'
  | 'settings_unreadable'
  | 'policy_resolver_failed'
  | 'detector_failed'
  | 'content_blocked'
  | 'embeddings_local_only'
  | 'stage_error';

const OPERATOR_MESSAGES: Record<PrivacyRefusalReason, string> = {
  app_init_failed:
    "The LLM privacy layer refused the call: the app's initAppPrivacyAdapters() threw, so the protection it registers is missing. Fix the app's privacy adapters (lib/app/privacy-adapters.ts) and restart.",
  core_install_failed:
    "The LLM privacy layer refused the call: one of Sunrise's own privacy adapters failed to install. See the server log for which, and restart once it is fixed.",
  settings_unreadable:
    'The LLM privacy layer refused the call: the stored privacy mode is not one the layer knows. Choose a mode in the orchestration settings.',
  policy_resolver_failed:
    'The LLM privacy layer refused the call: a privacy policy resolver failed, and it may have been the one that tightened the policy. See the server log for which.',
  detector_failed:
    'The LLM privacy layer refused the call: a required detector failed or ran out of time, and under a masking mode (or a policy that says block) a call that cannot be fully scanned is not sent. See the server log for which detector; a very large input is the usual cause.',
  content_blocked:
    'The LLM privacy layer refused the call: the privacy mode is block and the call contained personal data. Choose pseudonymise to send it with placeholders instead.',
  embeddings_local_only:
    "The LLM privacy layer refused an embedding call: the embeddings policy is local_only and the active embedding model's provider is not marked local. Use a local embedding model (see .context/orchestration/knowledge.md), or set the embeddings policy to allow.",
  stage_error:
    'The LLM privacy layer refused the call because of an internal error. Nothing was sent. See the server log.',
};

/** What an operator should do about a refusal: for the log, never the reader. */
export function refusalRemedy(reason: PrivacyRefusalReason): string {
  return OPERATOR_MESSAGES[reason];
}

/**
 * A provider call the privacy stage refused. Nothing was sent.
 *
 * The message is safe to show anyone: a workflow executor copies an error's
 * message into the `ExecutorError` that reaches the SSE client. The
 * operator's remedy, which names files and seams, is in the log line the
 * refusal writes ({@link refusalRemedy}).
 */
/**
 * What a refusal tells whoever reads it. Safe for anyone: it names a setting
 * at most, never a file, a value or the request.
 */
function readerMessage(reason: PrivacyRefusalReason): string {
  switch (reason) {
    case 'content_blocked':
      return 'The request was not sent: it contains personal details that this deployment does not send to an AI provider.';
    case 'embeddings_local_only':
      return "Embedding was refused: this deployment's privacy settings allow embeddings only with a local model (embeddings policy: local only), and the active embedding model is not local.";
    default:
      return "The request was stopped before it was sent, by the deployment's privacy settings.";
  }
}

/**
 * Where a `content_blocked` refusal of a chat call found personal details:
 * positions in the messages it was given, never what it found (§127 t-1017).
 * The caller that built the messages can tell which part of them held the
 * details, and so whether asking again can work.
 */
export interface PrivacyFindingLocation {
  /** How many messages the refused call carried, so a caller can check they are the ones it sent. */
  messageCount: number;
  /**
   * The indices of those messages that held a finding of their own, in order:
   * not one a detector only matched because it learned the value from
   * another message (t-1018).
   */
  messageIndices: readonly number[];
}

export class PrivacyRefusedError extends ProviderError {
  readonly reason: PrivacyRefusalReason;
  readonly providerSlug: string;
  /** Set on a `content_blocked` refusal of a chat call; absent otherwise. */
  readonly found?: PrivacyFindingLocation;
  constructor(reason: PrivacyRefusalReason, providerSlug: string, found?: PrivacyFindingLocation) {
    super(readerMessage(reason), {
      code: reason === 'content_blocked' ? PRIVACY_BLOCKED : PRIVACY_REFUSED,
      retriable: false,
    });
    this.name = 'PrivacyRefusedError';
    this.reason = reason;
    this.providerSlug = providerSlug;
    if (found) this.found = found;
  }
}

/**
 * Whether `err` is the refusal of an embedding call under `embeddingsPolicy:
 * local_only`. Each embedding caller answers it with its own remedy: a
 * reply's embedding is skipped, a knowledge search returns a tool error the
 * model can relay, an upload fails naming the setting (spec § Embeddings).
 */
export function isLocalOnlyEmbeddingRefusal(err: unknown): err is PrivacyRefusedError {
  return err instanceof PrivacyRefusedError && err.reason === 'embeddings_local_only';
}

/** One vendor call, as the Proxy hands it to the stage. */
export interface PrivacyStageCall {
  providerSlug: string;
  isLocal: boolean;
  coverage: Exclude<PrivacyCoverage, 'none'>;
  /** The method's arguments: `(messages, options)` for chat, `(text)` / `(texts, options)` for embeddings. */
  args: readonly unknown[];
}

/**
 * The call was abandoned by its caller before the stage finished with it. The
 * same shape every shipped provider throws for an aborted request, so callers
 * classify it as the cancel it is. The arguments are never handed back: they
 * were not fully scanned, and a provider that ignored its signal would send
 * them.
 */
class CallAbandonedError extends ProviderError {
  constructor() {
    super('request aborted', { code: 'aborted', retriable: false });
    this.name = 'CallAbandonedError';
  }
}

/** What the stage hands back: the arguments to send, and how to restore the reply. */
export interface PrivacyStageResult {
  args: readonly unknown[];
  /** Present under `pseudonymise` when something was masked: restore the reply with it. */
  restorer?: CallRestorer;
}

/** A chat call's messages, when its first argument is a list of them. */
function chatMessages(call: PrivacyStageCall): readonly LlmMessage[] {
  const [first] = call.args;
  return call.coverage === 'full' && Array.isArray(first) ? (first as LlmMessage[]) : [];
}

/**
 * The text a call would send, as one input: a chat call's pieces in order
 * (`chatPieces`, from `messagePieces`: message text, then the strings in its
 * tool-call arguments, keys included), or an embedding call's inputs. Joined, so a
 * name tier C learns in one message is found in the others; masking maps
 * the spans back onto the pieces by the same join.
 */
function outboundText(call: PrivacyStageCall, chatPieces: readonly string[] | null): string {
  if (chatPieces !== null) return chatPieces.join(PIECE_SEPARATOR);
  const [first] = call.args;
  const inputs =
    typeof first === 'string'
      ? [first]
      : Array.isArray(first)
        ? first.filter((t): t is string => typeof t === 'string')
        : [];
  return inputs.filter((p) => p.length > 0).join(PIECE_SEPARATOR);
}

/** `structured` when the call asks for JSON back: restored by parsing, not as text. */
function isStructured(call: PrivacyStageCall): boolean {
  const options = call.args[1];
  return (
    options !== null &&
    typeof options === 'object' &&
    'responseFormat' in options &&
    options.responseFormat !== undefined &&
    options.responseFormat !== null
  );
}

function countByType(spans: readonly { type: EntityType }[]): Record<EntityType, number> {
  const counts: Record<EntityType, number> = {};
  for (const s of spans) counts[s.type] = (counts[s.type] ?? 0) + 1;
  return counts;
}

function scopeFor(): { scope: PrivacyScope; ephemeral: boolean } {
  const scope = currentPrivacyScope();
  // A scope that only carries who the call is for is ephemeral for the scan.
  if (scope) return { scope, ephemeral: scope.recordsNowhere === true };
  // No turn or execution entered a scope: an ephemeral one for this call.
  // Its policy is the global one, never looser than a scoped call's.
  return {
    scope: createPrivacyScope({ scopeId: `ephemeral:${randomUUID()}` }),
    ephemeral: true,
  };
}

/**
 * The call's own cancellation signal, if it has one: `options.signal` on a
 * chat call. An abandoned call stops the detection pass with it.
 */
function callerSignal(call: PrivacyStageCall): AbortSignal | undefined {
  if (call.coverage !== 'full') return undefined;
  const options = call.args[1];
  if (options === null || typeof options !== 'object' || !('signal' in options)) return undefined;
  return options.signal instanceof AbortSignal ? options.signal : undefined;
}

/**
 * The org the call is for: the scope's, else the one the spend caps charge it
 * to (`orgIdForCall`): the tenant context's, or at `single` the install org.
 * A call with no org in context at `single` (an admin API key's request
 * enters none) would otherwise skip the install org's floor and protected
 * terms (t-1010). At `multi` such a call has already been refused.
 */
function orgOf(scope: PrivacyScope): string | undefined {
  return scope.orgId ?? orgIdForCall() ?? undefined;
}

function eventBase(
  scope: PrivacyScope,
  providerSlug: string
): Pick<PrivacyEvent, 'scopeId' | 'orgId' | 'agentId' | 'providerSlug'> {
  const orgId = orgOf(scope);
  return {
    scopeId: scope.scopeId,
    ...(orgId !== undefined ? { orgId } : {}),
    ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
    providerSlug,
  };
}

function refuse(
  reason: PrivacyRefusalReason,
  call: PrivacyStageCall,
  scope: PrivacyScope | undefined,
  mode: PrivacyPolicy['mode'] | undefined,
  failedAdapters: readonly string[] = [],
  found?: PrivacyFindingLocation
): PrivacyRefusedError {
  // A local-only refusal is the configuration working, once per embedding
  // the install asks for: info, so it does not bury real warnings.
  const fields = {
    reason,
    remedy: refusalRemedy(reason),
    providerSlug: call.providerSlug,
    ...(scope ? { scopeId: scope.scopeId } : {}),
    ...(failedAdapters.length > 0 ? { failedAdapters: [...failedAdapters] } : {}),
  };
  if (reason === 'embeddings_local_only') {
    logger.info('privacy-stage: refusing a provider call', fields);
  } else {
    logger.warn('privacy-stage: refusing a provider call', fields);
  }
  if (scope && mode) {
    recordPrivacyRefusal(scope, mode, reason);
    notifyPrivacyObservers({
      ...eventBase(scope, call.providerSlug),
      mode,
      counts: {},
      degraded: false,
      failedAdapters,
      outcome: 'refused',
    });
  }
  return new PrivacyRefusedError(reason, call.providerSlug, found);
}

/**
 * Run the stage on one call. Returns the arguments to send, and under
 * `pseudonymise` a restorer for the reply, or throws a
 * {@link PrivacyRefusedError}, in which case nothing may be sent.
 */
export async function applyPrivacyStage(call: PrivacyStageCall): Promise<PrivacyStageResult> {
  const unchanged: PrivacyStageResult = { args: call.args };
  const abandoned = callerSignal(call);
  let scope: PrivacyScope | undefined;
  let mode: PrivacyPolicy['mode'] | undefined;
  try {
    const adapters = getPrivacyAdapters();
    // Before the mode is even read: what failed may be what raised it.
    if (adapters.coreFailure !== null) throw refuse('core_install_failed', call, undefined, mode);
    if (adapters.appInitFailure !== null) throw refuse('app_init_failed', call, undefined, mode);

    const settings = await getOrchestrationSettings();
    // `hydrateSettings` has already read an absent column as `off`; a stored
    // value that is not a mode is `null`, and refuses.
    const base = basePolicyFromSettings(settings);
    const scoped = scopeFor();
    scope = scoped.scope;
    if (base === null) throw refuse('settings_unreadable', call, scope, mode);

    // Resolvers run even when the base is `off`: one may raise it. Inside the
    // call's scope, ephemeral or not, so core's resolver keeps what it reads
    // on the scope this call records into (`scopePrivacySettings`).
    const orgId = orgOf(scope);
    const resolving = scope;
    const { policy, failures: resolverFailures } = await runInPrivacyScope(resolving, () =>
      resolvePrivacyPolicy(
        base,
        {
          ...(orgId !== undefined ? { orgId } : {}),
          ...(resolving.agentId !== undefined ? { agentId: resolving.agentId } : {}),
          ...(resolving.userId !== undefined ? { userId: resolving.userId } : {}),
          providerSlug: call.providerSlug,
          isLocalProvider: call.isLocal,
        },
        abandoned
      )
    );
    // The caller gave up while the resolvers ran: a cancel, not a refusal.
    // The caller gave up while the resolvers ran. Thrown whatever the mode:
    // the policy may be missing the resolver that would have raised it, and a
    // provider that ignored its signal would send the call unscanned.
    if (abandoned?.aborted) throw new CallAbandonedError();
    mode = policy.mode;
    if (resolverFailures.length > 0) {
      throw refuse(
        'policy_resolver_failed',
        call,
        scope,
        mode,
        resolverFailures.map((f) => f.adapterId)
      );
    }

    if (policy.mode === 'off') return unchanged;
    if (call.isLocal && !policy.protectLocalProviders) {
      notifyPrivacyObservers({
        ...eventBase(scope, call.providerSlug),
        mode: policy.mode,
        counts: {},
        degraded: false,
        failedAdapters: [],
        outcome: 'skipped',
      });
      return unchanged;
    }
    // An embedding input is never masked: a masked name cannot be searched
    // for. Under a masking mode an install that requires local embeddings
    // refuses one to a provider that is not local instead (spec § Embeddings).
    if (
      call.coverage === 'count' &&
      !call.isLocal &&
      protectsContent(policy.mode) &&
      settings.privacyEmbeddingsPolicy === 'local_only'
    ) {
      throw refuse('embeddings_local_only', call, scope, mode);
    }

    // Nothing would read the result: an unscoped call (knowledge ingestion,
    // a background job) records nowhere, no observer is listening, and only a
    // `block` policy would act on a detector failing. A call the scan cannot
    // change — any call in `detect`, an embedding call in every mode — would be
    // scanned for nothing, and an external detector sent its text for nothing.
    // A chat call under a stricter mode always runs it: the scan is what
    // protects it.
    if (
      (policy.mode === 'detect' || call.coverage === 'count') &&
      scoped.ephemeral &&
      adapters.observers.length === 0 &&
      policy.onDetectorFailure !== 'block'
    ) {
      return unchanged;
    }

    // Loaded before the deadline starts: a slow user lookup must not spend
    // the detectors' time. The org's protected terms (t-1010) are known
    // values too; read once per scope, with the modes the resolver read.
    const [scopeValues, scopeSettings] = await Promise.all([
      knownValuesOf(scope),
      scopePrivacySettings(
        {
          ...(orgId !== undefined ? { orgId } : {}),
          ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
        },
        scope
      ),
    ]);
    const knownValues =
      scopeSettings.protectedTerms.length === 0
        ? scopeValues
        : [...scopeValues, ...scopeSettings.protectedTerms];
    // An org that names people or companies to protect is not ignoring that
    // type: the install's ignored types would otherwise drop its own
    // protected terms. Fewer ignored types is the stricter policy.
    const protectedTypes = new Set(scopeSettings.protectedTerms.map((t) => t.type));
    const ignoredEntityTypes =
      protectedTypes.size === 0
        ? policy.ignoredEntityTypes
        : policy.ignoredEntityTypes.filter((type) => !protectedTypes.has(type));
    const deadline = AbortSignal.timeout(PRIVACY_PASS_DEADLINE_MS);
    const pieces = call.coverage === 'full' ? messagePieces(chatMessages(call)) : null;
    const { spans, failures } = await runPrivacyDetectors(outboundText(call, pieces), {
      scopeId: scope.scopeId,
      ...(orgId !== undefined ? { orgId } : {}),
      ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
      knownValues,
      ignoredEntityTypes,
      signal: abandoned ? AbortSignal.any([abandoned, deadline]) : deadline,
    });
    // The caller gave up during the scan: the call was never fully scanned.
    // Neither counted nor refused; never handed back.
    if (abandoned?.aborted) throw new CallAbandonedError();
    const failedAdapters = failures.map((f) => f.adapterId);
    // A chat call under a stricter mode that could not be fully scanned would
    // go out with what the failed detector would have found in plaintext:
    // part-masked under `pseudonymise` and `redact`, unrefused under `block`.
    // Refused, like a `block` failure policy (owner ruling, 2026-11-11). An
    // embedding call is never masked, so a failure there changes nothing it
    // sends.
    const refuseOnFailure =
      policy.onDetectorFailure === 'block' ||
      (call.coverage === 'full' && protectsContent(policy.mode));
    if (failures.some((f) => f.required) && refuseOnFailure) {
      throw refuse('detector_failed', call, scope, mode, failedAdapters);
    }

    const counts = countByType(spans);
    if (call.coverage === 'full' && policy.mode === 'block' && spans.length > 0) {
      const messages = chatMessages(call);
      // Where, from what was found where it stands (t-1018). A value a
      // detector only matched because it learned it from another message
      // (a surname after the full name) places that message, not this
      // one. A detector that marked every span learned leaves nothing to
      // place by; then every span places, as before the flag existed.
      const own = spans.filter((s) => s.learned !== true);
      throw refuse('content_blocked', call, scope, mode, failedAdapters, {
        messageCount: messages.length,
        messageIndices: messagesHoldingSpans(
          messages,
          own.length > 0 ? own : spans,
          pieces ?? undefined
        ),
      });
    }

    let result: PrivacyStageResult = unchanged;
    if (call.coverage === 'full' && isMaskingMode(policy.mode)) {
      const strategy = adapters.tokenStrategy;
      // Core always registers one; an install without one cannot mask.
      if (strategy === null) throw new Error('no privacy token strategy registered');
      // One session per scope (in memory, gone with it); an ephemeral scope
      // is one call. See `PrivacyScope.tokenSession`.
      const session = (scope.tokenSession ??= strategy.createSession({
        scopeId: scope.scopeId,
        ...(orgId !== undefined ? { orgId } : {}),
      }));
      const declaredTypes = [...new Set(adapters.detectors.flatMap((d) => d.entityTypes))];
      const restoring = policy.mode === 'pseudonymise';
      const target = scope;
      const masked = maskMessages(chatMessages(call), spans, session, declaredTypes, restoring, {
        pieces: pieces ?? undefined,
      });
      // The instruction goes on every call under a masking mode, masked or
      // not, so the system prompt (the provider's cache prefix) never changes
      // partway through a conversation when the first value appears.
      result = {
        args: [withPlaceholderInstruction(masked.messages), ...call.args.slice(1)],
        ...(restoring && masked.changed
          ? {
              restorer: new CallRestorer(session, declaredTypes, isStructured(call), (r) =>
                recordPrivacyUnresolved(target, r.unresolved)
              ),
            }
          : {}),
      };
    }

    recordPrivacyCall(scope, {
      kind: call.coverage === 'full' ? 'chat' : 'embedding',
      mode: policy.mode,
      counts,
      degraded: failures.length > 0,
      failedAdapters,
    });
    notifyPrivacyObservers({
      ...eventBase(scope, call.providerSlug),
      mode: policy.mode,
      counts,
      degraded: failures.length > 0,
      failedAdapters,
      outcome: 'sent',
    });
    return result;
  } catch (err) {
    if (err instanceof PrivacyRefusedError) throw err;
    // The caller's own abort: a cancel, neither counted nor refused.
    if (err instanceof CallAbandonedError) throw err;
    // A bug refuses. Never sends unmasked.
    logger.error('privacy-stage: internal error', undefined, {
      providerSlug: call.providerSlug,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    throw refuse('stage_error', call, scope, mode);
  }
}
