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
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import { basePolicyFromSettings } from '@/lib/orchestration/privacy/settings-policy';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { modeStrictness } from '@/lib/privacy/adapters/policy';
import { getPrivacyAdapters } from '@/lib/privacy/adapters/registry';
import {
  notifyPrivacyObservers,
  resolvePrivacyPolicy,
  runPrivacyDetectors,
} from '@/lib/privacy/adapters/run';
import type { EntityType, PrivacyEvent, PrivacyPolicy } from '@/lib/privacy/adapters/types';
import { getTenantContext } from '@/lib/tenancy/context';

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

export class PrivacyRefusedError extends ProviderError {
  readonly reason: PrivacyRefusalReason;
  readonly providerSlug: string;
  constructor(reason: PrivacyRefusalReason, providerSlug: string) {
    super(readerMessage(reason), {
      code: reason === 'content_blocked' ? PRIVACY_BLOCKED : PRIVACY_REFUSED,
      retriable: false,
    });
    this.name = 'PrivacyRefusedError';
    this.reason = reason;
    this.providerSlug = providerSlug;
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
 * (`messagePieces`: message text, then the strings in its tool-call
 * arguments, keys included), or an embedding call's inputs. Joined, so a
 * name tier C learns in one message is found in the others; masking maps
 * the spans back onto the pieces by the same join.
 */
function outboundText(call: PrivacyStageCall): string {
  if (call.coverage === 'full') return messagePieces(chatMessages(call)).join(PIECE_SEPARATOR);
  const [first] = call.args;
  const pieces =
    typeof first === 'string'
      ? [first]
      : Array.isArray(first)
        ? first.filter((t): t is string => typeof t === 'string')
        : [];
  return pieces.filter((p) => p.length > 0).join(PIECE_SEPARATOR);
}

/** Whether `mode` replaces what it finds: `pseudonymise` and `redact`. */
function masks(mode: PrivacyPolicy['mode']): boolean {
  return mode === 'pseudonymise' || mode === 'redact';
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
  if (scope) return { scope, ephemeral: false };
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

/** The org the call is for: the scope's, else the tenant context's. */
function orgOf(scope: PrivacyScope): string | undefined {
  return scope.orgId ?? getTenantContext()?.orgId ?? undefined;
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
  failedAdapters: readonly string[] = []
): PrivacyRefusedError {
  logger.warn('privacy-stage: refusing a provider call', {
    reason,
    remedy: refusalRemedy(reason),
    providerSlug: call.providerSlug,
    ...(scope ? { scopeId: scope.scopeId } : {}),
    ...(failedAdapters.length > 0 ? { failedAdapters: [...failedAdapters] } : {}),
  });
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
  return new PrivacyRefusedError(reason, call.providerSlug);
}

/**
 * Run the stage on one call. Returns the arguments to send, and under
 * `pseudonymise` a restorer for the reply, or throws a
 * {@link PrivacyRefusedError}, in which case nothing may be sent.
 */
export async function applyPrivacyStage(call: PrivacyStageCall): Promise<PrivacyStageResult> {
  const unchanged: PrivacyStageResult = { args: call.args };
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

    // Resolvers run even when the base is `off`: one may raise it.
    const orgId = orgOf(scope);
    const abandoned = callerSignal(call);
    const { policy, failures: resolverFailures } = await resolvePrivacyPolicy(
      base,
      {
        ...(orgId !== undefined ? { orgId } : {}),
        ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        providerSlug: call.providerSlug,
        isLocalProvider: call.isLocal,
      },
      abandoned
    );
    // The caller gave up while the resolvers ran: a cancel, not a refusal.
    if (abandoned?.aborted) return unchanged;
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
      modeStrictness(policy.mode) >= modeStrictness('pseudonymise') &&
      settings.privacyEmbeddingsPolicy === 'local_only'
    ) {
      throw refuse('embeddings_local_only', call, scope, mode);
    }

    // Nothing would read the result: an unscoped call (knowledge ingestion,
    // a background job) records nowhere, no observer is listening, and only a
    // `block` policy would act on a detector failing. In `detect` no call is
    // altered, so the scan would be work for nothing. Under any stricter mode
    // the scan is what protects the call, so it always runs.
    if (
      policy.mode === 'detect' &&
      scoped.ephemeral &&
      adapters.observers.length === 0 &&
      policy.onDetectorFailure !== 'block'
    ) {
      return unchanged;
    }

    // Loaded before the deadline starts: a slow user lookup must not spend
    // the detectors' time.
    const knownValues = await knownValuesOf(scope);
    const deadline = AbortSignal.timeout(PRIVACY_PASS_DEADLINE_MS);
    const { spans, failures } = await runPrivacyDetectors(outboundText(call), {
      scopeId: scope.scopeId,
      ...(orgId !== undefined ? { orgId } : {}),
      ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
      knownValues,
      ignoredEntityTypes: policy.ignoredEntityTypes,
      signal: abandoned ? AbortSignal.any([abandoned, deadline]) : deadline,
    });
    // The caller gave up: the call is about to be cancelled, so it is neither
    // counted as sent nor refused. Its own signal ends it.
    if (abandoned?.aborted) return unchanged;
    const failedAdapters = failures.map((f) => f.adapterId);
    // A chat call under a masking mode that could not be fully scanned would
    // go out part-masked: what the failed detector would have found, in
    // plaintext. Refused, like a `block` policy (owner ruling, 2026-11-11).
    // An embedding call is never masked, so a failure there changes nothing
    // it sends.
    const refuseOnFailure =
      policy.onDetectorFailure === 'block' || (call.coverage === 'full' && masks(policy.mode));
    if (failures.some((f) => f.required) && refuseOnFailure) {
      throw refuse('detector_failed', call, scope, mode, failedAdapters);
    }

    const counts = countByType(spans);
    if (call.coverage === 'full' && policy.mode === 'block' && spans.length > 0) {
      throw refuse('content_blocked', call, scope, mode, failedAdapters);
    }

    let result: PrivacyStageResult = unchanged;
    if (call.coverage === 'full' && masks(policy.mode)) {
      const strategy = adapters.tokenStrategy;
      // Core always registers one; an install without one cannot mask.
      if (strategy === null) throw new Error('no privacy token strategy registered');
      const session = strategy.createSession({
        scopeId: scope.scopeId,
        ...(orgId !== undefined ? { orgId } : {}),
      });
      const declaredTypes = [...new Set(adapters.detectors.flatMap((d) => d.entityTypes))];
      const restoring = policy.mode === 'pseudonymise';
      const masked = maskMessages(chatMessages(call), spans, session, declaredTypes, restoring);
      if (masked.changed) {
        const target = scope;
        result = {
          args: [withPlaceholderInstruction(masked.messages), ...call.args.slice(1)],
          ...(restoring
            ? {
                restorer: new CallRestorer(session, declaredTypes, isStructured(call), (r) =>
                  recordPrivacyUnresolved(target, r.unresolved)
                ),
              }
            : {}),
        };
      }
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
    // A bug refuses. Never sends unmasked.
    logger.error('privacy-stage: internal error', undefined, {
      providerSlug: call.providerSlug,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    throw refuse('stage_error', call, scope, mode);
  }
}
