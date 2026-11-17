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
 * Before any of that, a call made in a scope that records somewhere is
 * classified for confidential content (§130), in every mode and to local
 * providers too, and the categories found are recorded in its scope. So is a
 * call in any scope that a confidential-content policy could refuse. Each
 * group's policy then decides: a call holding content of a group whose policy
 * is `block`, or does not permit the call's provider, is refused, and a
 * classifier failure counts as flagged under those policies.
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
import {
  PRIVACY_BLOCKED,
  PRIVACY_CONFIDENTIAL,
  PRIVACY_REFUSED,
  ProviderError,
} from '@/lib/orchestration/llm/provider';
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
  recordConfidentialDecision,
  recordPrivacyCall,
  recordPrivacyRefusal,
  recordPrivacySensitivity,
  recordPrivacyUnresolved,
  runInPrivacyScope,
  type PrivacyScope,
} from '@/lib/orchestration/privacy/scope';
import { scopePrivacySettings } from '@/lib/orchestration/privacy/scope-settings';
import {
  basePolicyFromSettings,
  CONFIDENTIAL_POLICY_FIELD,
  isMaskingMode,
  protectsContent,
} from '@/lib/orchestration/privacy/settings-policy';
import { getOrchestrationSettings } from '@/lib/orchestration/settings';
import { getPrivacyAdapters } from '@/lib/privacy/adapters/registry';
import { confidentialStrictness } from '@/lib/privacy/adapters/policy';
import {
  notifyPrivacyObservers,
  resolvePrivacyPolicy,
  runPrivacyDetectors,
  runSensitivityClassifiers,
} from '@/lib/privacy/adapters/run';
import {
  SENSITIVITY_GROUPS,
  type ConfidentialPolicy,
  type EntityType,
  type PrivacyEvent,
  type PrivacyPolicy,
  type SensitivityGroup,
  type SensitivityPart,
} from '@/lib/privacy/adapters/types';
import type { ConfidentialDecision } from '@/types/orchestration';
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
  | 'confidential_blocked'
  | 'confidential_not_permitted'
  | 'confidential_unchecked'
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
  confidential_blocked:
    'The LLM privacy layer refused the call: it held confidential content of a group whose policy is block, or a confidential-content classifier failed under that policy. Choose a looser policy for the group in the orchestration settings or on the agent, or leave the agent as it is if the content should never be sent.',
  confidential_not_permitted:
    'The LLM privacy layer refused the call: it held confidential content of a group whose policy sends it only to local providers (local_only) or to trusted and local ones (approved_only), or a confidential-content classifier failed under that policy, and the call\'s provider is neither. A chat turn or agent step moves to the model for confidential messages (Settings → LLM privacy) when one is set and permitted; this call was not moved, because none is, or because the caller chose its own model. Choose that model, put the agent on a local provider, tick the provider "Trusted with confidential content" if your contract with it covers this content, or loosen the group\'s policy.',
  confidential_unchecked:
    'The LLM privacy layer refused the call: a confidential-content classifier failed or ran out of time, and a group whose policy is approved_only, local_only or block would have refused the call had it found that content, so a call it could not check is not sent. See the server log for which classifier; it is tried again on the next call.',
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
    case 'confidential_blocked':
    case 'confidential_not_permitted':
      return 'The request was not sent: it contains confidential content that this deployment does not send to this AI provider.';
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

/** The `ProviderError` code a refusal carries: what the reader can do about it. */
function refusalCode(reason: PrivacyRefusalReason): string {
  if (reason === 'content_blocked') return PRIVACY_BLOCKED;
  if (isConfidentialReason(reason)) return PRIVACY_CONFIDENTIAL;
  return PRIVACY_REFUSED;
}

function isConfidentialReason(reason: PrivacyRefusalReason): boolean {
  return reason === 'confidential_blocked' || reason === 'confidential_not_permitted';
}

export class PrivacyRefusedError extends ProviderError {
  readonly reason: PrivacyRefusalReason;
  readonly providerSlug: string;
  /**
   * Set on a `content_blocked` refusal of a chat call, and on a confidential
   * one when the stage could tell which messages held the content; absent
   * otherwise.
   */
  readonly found?: PrivacyFindingLocation;
  constructor(reason: PrivacyRefusalReason, providerSlug: string, found?: PrivacyFindingLocation) {
    super(readerMessage(reason), {
      code: refusalCode(reason),
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

/**
 * Whether `err` is a refusal for confidential content (§130): the call held
 * content of a group whose policy blocks it, or does not permit its provider.
 * An embedding caller answers it as it answers {@link isLocalOnlyEmbeddingRefusal}.
 */
export function isConfidentialRefusal(err: unknown): err is PrivacyRefusedError {
  return err instanceof PrivacyRefusedError && isConfidentialReason(err.reason);
}

/** One vendor call, as the Proxy hands it to the stage. */
export interface PrivacyStageCall {
  providerSlug: string;
  isLocal: boolean;
  /**
   * Whether the provider is ticked "Trusted with confidential content"
   * (§130). Asked only when a policy of `approved_only` needs the answer; a
   * call without it, or a lookup that fails, is treated as untrusted.
   */
  isTrusted?: () => Promise<boolean>;
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
 * What a call sends, part by part with its role, for the sensitivity
 * classifiers (§130): each chat message's text, or each embedding input, with
 * the index of the message (or input) it came from. A chat call's tool-call
 * arguments are left out: they are the model's, derived from what the user
 * wrote, which is classified already. An embedding call's input is classified
 * whoever wrote it (a model-written search query included), because it is
 * text that goes to the embedding provider.
 */
function sensitivityParts(call: PrivacyStageCall): { index: number; part: SensitivityPart }[] {
  const parts: { index: number; part: SensitivityPart }[] = [];
  if (call.coverage === 'full') {
    chatMessages(call).forEach((m, index) => {
      if (typeof m.content === 'string') {
        if (m.content.length > 0) parts.push({ index, part: { role: m.role, text: m.content } });
        return;
      }
      for (const part of m.content) {
        if (part.type === 'text' && part.text.length > 0) {
          parts.push({ index, part: { role: m.role, text: part.text } });
        }
      }
    });
    return parts;
  }
  const [first] = call.args;
  const inputs = typeof first === 'string' ? [first] : Array.isArray(first) ? first : [];
  inputs.forEach((text, index) => {
    if (typeof text === 'string' && text.length > 0) {
      parts.push({ index, part: { role: 'embedding', text } });
    }
  });
  return parts;
}

/**
 * Listed as the failed adapter when classifying a call failed outside any one
 * classifier (a fault in the stage's own classification step), so the trace
 * shows it degraded rather than nothing.
 */
const SENSITIVITY_STAGE_FAILURE = 'privacy-stage.sensitivity';

/**
 * Listed as the failed adapter when a policy could refuse a call and no
 * registered classifier could look at it: every one is external and the call
 * goes to a local provider. Counted as a failure, so the strict policy holds.
 */
const SENSITIVITY_NO_CLASSIFIER = 'privacy-stage.no-classifier';

/** What classifying a call found: the groups, and whether anything failed. */
interface Classification {
  groups: ReadonlySet<SensitivityGroup>;
  /** The classifiers that failed, or the stage's own classification step: empty when none did. */
  failedAdapters: readonly string[];
}

/** How many messages a refused call's placement classifies at once. */
const LOCATE_CONCURRENCY = 4;

const NOTHING_CLASSIFIED: Classification = { groups: new Set(), failedAdapters: [] };

/** What the classifiers are told about the call, besides its parts. */
interface ClassifyOptions {
  scope: PrivacyScope;
  orgId: string | undefined;
  abandoned: AbortSignal | undefined;
  /** Skip external classifiers: the call is forwarded untouched. */
  inHouseOnly: boolean;
}

/**
 * Classify the call for confidential content and record what was found in
 * its scope (§130), whether the call is then sent or refused, and return it
 * for the policy to act on.
 *
 * A fault here never refuses by itself: it is recorded as degraded, and
 * returned as a failure, which a strict policy then counts as flagged
 * ({@link confidentialVerdict}). Records nothing when nothing was found and
 * no classifier failed, so a turn gains a privacy summary only when what its
 * calls carried held something confidential. Each call resends the history,
 * so a disclosure from an earlier turn is found again on every later turn
 * that carried it, as the PII counts are.
 */
async function classifyCall(
  call: PrivacyStageCall,
  mode: PrivacyPolicy['mode'],
  { scope, orgId, abandoned, inHouseOnly }: ClassifyOptions
): Promise<Classification> {
  let classified: Awaited<ReturnType<typeof runSensitivityClassifiers>> | null;
  try {
    const parts = sensitivityParts(call).map((p) => p.part);
    if (parts.length === 0) return NOTHING_CLASSIFIED;
    const deadline = AbortSignal.timeout(PRIVACY_PASS_DEADLINE_MS);
    classified = await runSensitivityClassifiers(
      { parts },
      {
        scopeId: scope.scopeId,
        ...(orgId !== undefined ? { orgId } : {}),
        ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
        signal: abandoned ? AbortSignal.any([abandoned, deadline]) : deadline,
        inHouseOnly,
      }
    );
  } catch (err) {
    logger.error('privacy-stage: sensitivity classification failed', undefined, {
      providerSlug: call.providerSlug,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    classified = null;
  }
  // The caller's own cancel stays a cancel, whatever happened above.
  if (abandoned?.aborted) throw new CallAbandonedError();
  if (classified === null) {
    recordPrivacySensitivity(scope, {
      mode,
      categories: [],
      failedAdapters: [SENSITIVITY_STAGE_FAILURE],
    });
    return { groups: new Set(), failedAdapters: [SENSITIVITY_STAGE_FAILURE] };
  }
  const { categories, failures } = classified;
  if (categories.length === 0 && failures.length === 0) return NOTHING_CLASSIFIED;
  const failedAdapters = failures.map((f) => f.adapterId);
  recordPrivacySensitivity(scope, { mode, categories, failedAdapters });
  return { groups: new Set(categories.map((c) => c.group)), failedAdapters };
}

/** The policy that governs `group` for this call. */
function groupPolicy(policy: PrivacyPolicy, group: SensitivityGroup): ConfidentialPolicy {
  return policy[CONFIDENTIAL_POLICY_FIELD[group]];
}

/**
 * A policy that can refuse a call: `block`, or one that sends confidential
 * content only to some providers. A classifier failure counts as flagged
 * under these (fail closed); under `allow` and `warn` it is only recorded.
 */
function refusesSomewhere(policy: ConfidentialPolicy): boolean {
  return confidentialStrictness(policy) >= confidentialStrictness('approved_only');
}

/**
 * Whether the provider is trusted, asked once per call and only when a
 * policy needs the answer. A call without the lookup, or a lookup that
 * fails, is untrusted.
 */
function trustedOnce(call: PrivacyStageCall): () => Promise<boolean> {
  let trusted: Promise<boolean> | undefined;
  return () => (trusted ??= (call.isTrusted?.() ?? Promise.resolve(false)).catch(() => false));
}

/**
 * Whether a call holding content of a group under `policy` is refused at
 * this provider: always under `block`; under `local_only` unless it is
 * local; under `approved_only` unless it is local or trusted.
 */
async function groupRefuses(
  policy: ConfidentialPolicy,
  isLocal: boolean,
  isTrusted: () => Promise<boolean>
): Promise<boolean> {
  if (policy === 'block') return true;
  if (policy === 'local_only') return !isLocal;
  if (policy === 'approved_only') return !isLocal && !(await isTrusted());
  return false;
}

/**
 * Whether a policy of either group would refuse this call if it held that
 * group's content. Decides whether a call in a scope that records nowhere
 * must be classified, and whether external classifiers run on a call the
 * masking forwards untouched.
 */
async function confidentialPolicyCouldRefuse(
  policy: PrivacyPolicy,
  call: PrivacyStageCall,
  isTrusted: () => Promise<boolean>
): Promise<boolean> {
  for (const g of SENSITIVITY_GROUPS) {
    if (await groupRefuses(groupPolicy(policy, g), call.isLocal, isTrusted)) return true;
  }
  return false;
}

/** What the policy says about a classified call. */
type ConfidentialVerdict =
  | { kind: 'none' }
  | { kind: 'send'; decisions: Partial<Record<SensitivityGroup, ConfidentialDecision>> }
  | {
      kind: 'refuse';
      reason: 'confidential_blocked' | 'confidential_not_permitted';
      /** The flagged groups whose policy refused the call. */
      groups: readonly SensitivityGroup[];
      /** The groups found, each `refused`, for the trace. */
      decisions: Partial<Record<SensitivityGroup, ConfidentialDecision>>;
    };

/**
 * Apply each group's policy to what the call was found to hold (§130, spec
 * § Policy). A group counts as flagged when content of it was found, or,
 * under a policy that can refuse, when a classifier failed. A call flagged in
 * both groups is held to each group's policy, so the stricter wins:
 *
 * - `block` refuses it, whatever the provider.
 * - `local_only` refuses it unless the provider is local.
 * - `approved_only` refuses it unless the provider is local or trusted.
 * - `warn` and `allow` send it; `warn` is told to the user after.
 */
async function confidentialVerdict(
  policy: PrivacyPolicy,
  classification: Classification,
  call: PrivacyStageCall,
  isTrusted: () => Promise<boolean>
): Promise<ConfidentialVerdict> {
  const flagged = SENSITIVITY_GROUPS.filter(
    (g) =>
      classification.groups.has(g) ||
      (classification.failedAdapters.length > 0 && refusesSomewhere(groupPolicy(policy, g)))
  );
  if (flagged.length === 0) return { kind: 'none' };
  const refusing: SensitivityGroup[] = [];
  let blocked = false;
  for (const g of flagged) {
    const p = groupPolicy(policy, g);
    if (await groupRefuses(p, call.isLocal, isTrusted)) {
      refusing.push(g);
      if (p === 'block') blocked = true;
    }
  }
  const found = SENSITIVITY_GROUPS.filter((g) => classification.groups.has(g));
  if (refusing.length > 0) {
    return {
      kind: 'refuse',
      reason: blocked ? 'confidential_blocked' : 'confidential_not_permitted',
      groups: refusing,
      decisions: Object.fromEntries(found.map((g) => [g, 'refused' as const])),
    };
  }
  return {
    kind: 'send',
    decisions: Object.fromEntries(
      found.map((g) => [g, groupPolicy(policy, g) === 'warn' ? 'warned' : 'allowed'] as const)
    ),
  };
}

/** What a sent call's confidential content was decided, per group: recorded once it is sent. */
type SentDecisions = Partial<Record<SensitivityGroup, ConfidentialDecision>>;

/**
 * The backstop (§130): classify the call, then refuse it if a group it holds
 * has a policy that does not permit its provider. Runs after the policy is
 * resolved and before the returns for `off` and a skipped local provider, so
 * it holds in every mode. Records what was found and what was decided.
 */
async function applyConfidentialPolicy(
  call: PrivacyStageCall,
  policy: PrivacyPolicy,
  opts: {
    scope: PrivacyScope;
    orgId: string | undefined;
    abandoned: AbortSignal | undefined;
    ephemeral: boolean;
    forwardedUntouched: boolean;
    /** Whether any registered classifier is not external. */
    anyInHouse: boolean;
  }
): Promise<SentDecisions | undefined> {
  const { scope, orgId, abandoned, ephemeral, forwardedUntouched, anyInHouse } = opts;
  const isTrusted = trustedOnce(call);
  // Whether a policy could refuse this call matters only to a call that
  // records nowhere (classified only if so) and to one forwarded untouched
  // (external classifiers run only if so): elsewhere, asking would look the
  // provider up for nothing.
  const couldRefuse =
    (ephemeral || forwardedUntouched) &&
    (await confidentialPolicyCouldRefuse(policy, call, isTrusted));
  // In a scope that records nowhere, nothing reads the result unless a
  // policy could act on it.
  if (ephemeral && !couldRefuse) return undefined;
  // Recorded under `off` when the call goes out unscanned: the summary's mode
  // is the strictest any SCANNED call ran under, and a skipped local call was
  // not scanned, so it must not raise it.
  const recordedMode = forwardedUntouched ? 'off' : policy.mode;
  // External classifiers see a call forwarded untouched only when it is going
  // to a remote provider anyway and a policy could refuse it there: without
  // them, a fork whose only classifier is external would have its strict
  // policy enforced by nothing (t-1037 review). A local call never goes to one.
  const inHouseOnly = forwardedUntouched && !(couldRefuse && !call.isLocal);
  const classifying: ClassifyOptions = { scope, orgId, abandoned, inHouseOnly };
  let classification = await classifyCall(call, recordedMode, classifying);
  // A policy that could refuse a call with text in it, and no classifier able
  // to look at it: fail closed, as for a classifier that failed.
  if (couldRefuse && inHouseOnly && !anyInHouse && sensitivityParts(call).length > 0) {
    classification = {
      ...classification,
      failedAdapters: [...classification.failedAdapters, SENSITIVITY_NO_CLASSIFIER],
    };
    recordPrivacySensitivity(scope, {
      mode: recordedMode,
      categories: [],
      failedAdapters: [SENSITIVITY_NO_CLASSIFIER],
    });
  }
  const verdict = await confidentialVerdict(policy, classification, call, isTrusted);
  // Recorded by the caller once the call is actually sent: the detectors can
  // still refuse it after this.
  if (verdict.kind === 'send') return verdict.decisions;
  if (verdict.kind !== 'refuse') return undefined;
  // A call its caller gave up on is a cancel, not a refusal.
  if (abandoned?.aborted) throw new CallAbandonedError();
  recordConfidentialDecision(scope, verdict.decisions);
  // The reason and the place come from the refusing groups whose content was
  // found. Refused only because a classifier failed (none was found): the
  // reader is not told their message held something, and nothing is placed.
  const foundRefusing = verdict.groups.filter((g) => classification.groups.has(g));
  const reason =
    foundRefusing.length === 0
      ? 'confidential_unchecked'
      : foundRefusing.some((g) => groupPolicy(policy, g) === 'block')
        ? 'confidential_blocked'
        : 'confidential_not_permitted';
  const location =
    foundRefusing.length > 0
      ? await locateConfidential(call, foundRefusing, classifying)
      : undefined;
  if (abandoned?.aborted) throw new CallAbandonedError();
  throw refuse(reason, call, opts.scope, recordedMode, classification.failedAdapters, location);
}

/**
 * Which messages of a refused chat call held content of the refused groups
 * (§130): positions only, never what was found, so the chat handler can leave
 * an earlier message out of what later turns send (§127 t-1017's placement).
 *
 * Classifiers report what a call holds, not where, so each message is
 * classified again on its own. Only on a refusal, and only the messages
 * with text, a few at a time. Undefined when nothing could be placed (no
 * message held it on its own, or every run failed): the handler then leaves
 * out the turn alone.
 */
async function locateConfidential(
  call: PrivacyStageCall,
  groups: readonly SensitivityGroup[],
  { scope, orgId, abandoned, inHouseOnly }: ClassifyOptions
): Promise<PrivacyFindingLocation | undefined> {
  if (call.coverage !== 'full') return undefined;
  const messages = chatMessages(call);
  const byMessage = new Map<number, SensitivityPart[]>();
  for (const { index, part } of sensitivityParts(call)) {
    const list = byMessage.get(index) ?? [];
    list.push(part);
    byMessage.set(index, list);
  }
  try {
    const deadline = AbortSignal.timeout(PRIVACY_PASS_DEADLINE_MS);
    const signal = abandoned ? AbortSignal.any([abandoned, deadline]) : deadline;
    const pending = [...byMessage];
    const results: { index: number; groups: SensitivityGroup[] }[] = [];
    // A few messages at a time, not the whole history at once: an external
    // classifier would otherwise get one request per message in a burst.
    const worker = async (): Promise<void> => {
      // One run that throws ends the pass: the others stop taking messages.
      for (let next = pending.shift(); next; next = pending.shift()) {
        const [index, parts] = next;
        const { categories } = await runSensitivityClassifiers(
          { parts },
          {
            scopeId: scope.scopeId,
            ...(orgId !== undefined ? { orgId } : {}),
            ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
            signal,
            inHouseOnly,
          }
        );
        results.push({ index, groups: categories.map((c) => c.group) });
      }
    };
    await Promise.all(
      Array.from({ length: LOCATE_CONCURRENCY }, () =>
        worker().catch((err: unknown) => {
          pending.length = 0;
          throw err;
        })
      )
    );
    // A message a classifier failed on is not placed, but the ones found are:
    // left out, they stop refusing later turns, and a failed one is tried
    // again on the next refusal. Placing nothing would keep them all.
    const indices = results
      .filter((r) => r.groups.some((g) => groups.includes(g)))
      .map((r) => r.index)
      .sort((a, b) => a - b);
    return indices.length === 0
      ? undefined
      : { messageCount: messages.length, messageIndices: indices };
  } catch (err) {
    logger.warn('privacy-stage: could not place a confidential-content refusal', {
      providerSlug: call.providerSlug,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return undefined;
  }
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
 * The policy a call to `provider` runs under in `scope`: the settings' base,
 * tightened by every resolver. Inside the scope, ephemeral or not, so core's
 * resolver keeps what it reads on the scope the call records into
 * (`scopePrivacySettings`). The stage and routing (t-1038) both resolve
 * through here, so they cannot disagree about the policy.
 */
function resolvePolicyFor(
  scope: PrivacyScope,
  base: PrivacyPolicy,
  provider: { slug: string; isLocal: boolean },
  abandoned: AbortSignal | undefined
): ReturnType<typeof resolvePrivacyPolicy> {
  const orgId = orgOf(scope);
  return runInPrivacyScope(scope, () =>
    resolvePrivacyPolicy(
      base,
      {
        ...(orgId !== undefined ? { orgId } : {}),
        ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
        ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
        providerSlug: provider.slug,
        isLocalProvider: provider.isLocal,
      },
      abandoned
    )
  );
}

/** A provider routing (t-1038) may send a turn to. */
export interface RoutingCandidate {
  slug: string;
  isLocal: boolean;
  /** Whether it is ticked "Trusted with confidential content"; asked only when a policy needs it. */
  isTrusted: () => Promise<boolean>;
}

/** What routing should do with a turn (t-1038). */
export interface ConfidentialRouting {
  /**
   * - `stay`: keep the agent's provider. Nothing flagged is refused there, or
   *   nothing could help (a `block` policy, an unreadable policy), and the
   *   stage decides each call as it would anyway.
   * - `move`: the agent's provider is refused for something flagged, and the
   *   target is permitted for everything flagged.
   * - `unavailable`: the agent's provider is refused for something flagged,
   *   and there is no target, or it is refused too. The stage refuses the call.
   */
  verdict: 'stay' | 'move' | 'unavailable';
  /** The groups the classifiers found in what was classified: to keep on the conversation. */
  found: SensitivityGroup[];
  /**
   * The fallbacks no flagged group refuses, in order: the agent's own list
   * when nothing is flagged. A moved turn uses none: a fallback is sent the
   * primary's model id.
   */
  fallbacks: string[];
}

/**
 * Where a turn holding confidential content can be answered (§130 t-1038),
 * decided at its start, before the request is built: by then the stage could
 * only refuse. The same policy, classifiers and per-group rule as the stage
 * ({@link groupRefuses}), so routing and the backstop never disagree about a
 * provider.
 *
 * Classifies only when a group's policy could refuse the agent's provider or
 * one of its fallbacks: otherwise there is nothing to route, and an install
 * on `allow` and `warn` pays nothing. External classifiers run as the stage
 * would run them on the turn's first call: always under a masking mode, and
 * for a call it forwards untouched only when the agent's provider is remote
 * and its policy could refuse it. Nothing is recorded here: the stage records each call it
 * classifies, and this pass is not a call. A group counts as flagged when
 * content of it was found, when it is in `sticky` (found on an earlier turn
 * of the conversation, which may since have been summarised away), or, under
 * a policy that can refuse, when a classifier failed.
 */
export async function confidentialRouting(input: {
  parts: readonly SensitivityPart[];
  sticky: readonly SensitivityGroup[];
  primary: RoutingCandidate;
  fallbacks: readonly RoutingCandidate[];
  target: RoutingCandidate | null;
  /** The settings the caller read already, so a turn reads them once. */
  settings: Awaited<ReturnType<typeof getOrchestrationSettings>>;
  signal?: AbortSignal;
}): Promise<ConfidentialRouting> {
  const { parts, sticky, primary, fallbacks, target, settings, signal } = input;
  const unchanged: ConfidentialRouting = {
    verdict: 'stay',
    found: [],
    fallbacks: fallbacks.map((f) => f.slug),
  };
  const adapters = getPrivacyAdapters();
  // The stage refuses every call in these cases; routing cannot help.
  if (adapters.coreFailure !== null || adapters.appInitFailure !== null) return unchanged;
  const base = basePolicyFromSettings(settings);
  if (base === null) return unchanged;
  const { scope } = scopeFor();
  const policyAt = async (c: RoutingCandidate): Promise<PrivacyPolicy | null> => {
    const { policy, failures } = await resolvePolicyFor(scope, base, c, signal);
    return failures.length > 0 ? null : policy;
  };
  const refusedAt = async (
    policy: PrivacyPolicy,
    groups: readonly SensitivityGroup[],
    c: RoutingCandidate
  ): Promise<SensitivityGroup[]> => {
    const refused: SensitivityGroup[] = [];
    for (const g of groups) {
      if (await groupRefuses(groupPolicy(policy, g), c.isLocal, c.isTrusted)) refused.push(g);
    }
    return refused;
  };

  const primaryPolicy = await policyAt(primary);
  if (primaryPolicy === null) return unchanged;
  // A fallback's policy is resolved only when something asks about it:
  // resolvers may do I/O, and most turns never need one.
  const fallbackPolicies = new Map<number, Promise<PrivacyPolicy | null>>();
  const fallbackPolicy = (i: number): Promise<PrivacyPolicy | null> => {
    let resolved = fallbackPolicies.get(i);
    if (!resolved) {
      resolved = policyAt(fallbacks[i]);
      fallbackPolicies.set(i, resolved);
    }
    return resolved;
  };
  // Nothing to route unless some policy could refuse a provider the turn
  // could reach. A group under `block` is left out of this question: it is
  // refused at every provider, so routing cannot help, and an install whose
  // only strict group is blocked pays for no classification here.
  const routable = (policy: PrivacyPolicy) =>
    SENSITIVITY_GROUPS.filter((g) => groupPolicy(policy, g) !== 'block');
  const primaryCouldRefuse =
    (await refusedAt(primaryPolicy, routable(primaryPolicy), primary)).length > 0;
  let couldRefuse = primaryCouldRefuse;
  for (let i = 0; !couldRefuse && i < fallbacks.length; i++) {
    const p = await fallbackPolicy(i);
    couldRefuse = p === null || (await refusedAt(p, routable(p), fallbacks[i])).length > 0;
  }
  if (!couldRefuse) return unchanged;

  let found: SensitivityGroup[] = [];
  let failed = false;
  try {
    const textParts = parts.filter((p) => p.text.length > 0);
    if (textParts.length > 0) {
      const deadline = AbortSignal.timeout(PRIVACY_PASS_DEADLINE_MS);
      const orgId = orgOf(scope);
      const { categories, failures } = await runSensitivityClassifiers(
        { parts: textParts },
        {
          scopeId: scope.scopeId,
          ...(orgId !== undefined ? { orgId } : {}),
          ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
          signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
          // The stage's rule for the call the turn starts with: a call it
          // forwards untouched goes to external classifiers only when it is
          // remote and its own policy could refuse it.
          inHouseOnly:
            (primaryPolicy.mode === 'off' ||
              (primary.isLocal && !primaryPolicy.protectLocalProviders)) &&
            !(primaryCouldRefuse && !primary.isLocal),
        }
      );
      found = SENSITIVITY_GROUPS.filter((g) => categories.some((c) => c.group === g));
      failed = failures.length > 0;
    }
  } catch (err) {
    logger.error('privacy-stage: classifying a turn for routing failed', undefined, {
      providerSlug: primary.slug,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    failed = true;
  }

  const flagged = SENSITIVITY_GROUPS.filter(
    (g) =>
      found.includes(g) ||
      sticky.includes(g) ||
      (failed && refusesSomewhere(groupPolicy(primaryPolicy, g)))
  );
  if (flagged.length === 0) return { ...unchanged, found };
  // `block` refuses whatever the provider: routing cannot help.
  if (flagged.some((g) => groupPolicy(primaryPolicy, g) === 'block')) {
    return { ...unchanged, found };
  }
  const permitted: string[] = [];
  for (let i = 0; i < fallbacks.length; i++) {
    const p = await fallbackPolicy(i);
    if (p !== null && (await refusedAt(p, flagged, fallbacks[i])).length === 0) {
      permitted.push(fallbacks[i].slug);
    }
  }
  if ((await refusedAt(primaryPolicy, flagged, primary)).length === 0) {
    return { verdict: 'stay', found, fallbacks: permitted };
  }
  if (target !== null) {
    const targetPolicy = await policyAt(target);
    if (targetPolicy !== null && (await refusedAt(targetPolicy, flagged, target)).length === 0) {
      return { verdict: 'move', found, fallbacks: permitted };
    }
  }
  return { verdict: 'unavailable', found, fallbacks: permitted };
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

    // Resolvers run even when the base is `off`: one may raise it.
    const orgId = orgOf(scope);
    const { policy, failures: resolverFailures } = await resolvePolicyFor(
      scope,
      base,
      { slug: call.providerSlug, isLocal: call.isLocal },
      abandoned
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

    // Before the returns for `off` and a skipped local provider: classifying
    // changes nothing sent, and an install records what its agents meet in
    // every mode (owner ruling, 2026-11-17).
    // An embedding input is never masked: a masked name cannot be searched
    // for. Under a masking mode an install that requires local embeddings
    // refuses one to a provider that is not local instead (spec § Embeddings).
    // Before classifying, so a refused embedding's text reaches no external
    // classifier; it implies a masking mode and a provider that is not local,
    // so neither return below would have come first.
    if (
      call.coverage === 'count' &&
      !call.isLocal &&
      protectsContent(policy.mode) &&
      settings.privacyEmbeddingsPolicy === 'local_only'
    ) {
      throw refuse('embeddings_local_only', call, scope, mode);
    }

    // A call the layer forwards untouched (mode `off`, or a local provider it
    // skips) is not sent to an external classifier either: that would be the
    // one place its text went beyond the provider the operator chose. One
    // exception, below: a remote call a confidential-content policy could
    // refuse.
    const forwardedUntouched =
      policy.mode === 'off' || (call.isLocal && !policy.protectLocalProviders);
    // What the operator sent itself (knowledge being ingested) is not
    // classified: the policies are about what users write (spec § What is
    // classified).
    const sentDecisions = scope.operatorContent
      ? undefined
      : await applyConfidentialPolicy(call, policy, {
          scope,
          orgId,
          abandoned,
          ephemeral: scoped.ephemeral,
          forwardedUntouched,
          anyInHouse: adapters.classifiers.some((c) => c.egress !== 'external'),
        });
    // Recorded only on the paths that send the call (§130 t-1037 review): a
    // call the detectors then refuse must not read "warned" on the trace, nor
    // show the user a note for something never sent.
    const decidedScope = scope;
    const recordingIt = <T>(value: T): T => {
      if (sentDecisions) recordConfidentialDecision(decidedScope, sentDecisions);
      return value;
    };

    if (policy.mode === 'off') return recordingIt(unchanged);
    if (call.isLocal && !policy.protectLocalProviders) {
      notifyPrivacyObservers({
        ...eventBase(scope, call.providerSlug),
        mode: policy.mode,
        counts: {},
        degraded: false,
        failedAdapters: [],
        outcome: 'skipped',
      });
      return recordingIt(unchanged);
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
      return recordingIt(unchanged);
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
    return recordingIt(result);
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
