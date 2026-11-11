/**
 * The LLM privacy stage: what the provider-manager Proxy runs on every
 * protected vendor call, after the eligibility and spend gates (§127).
 *
 * This version acts in `off` and `detect`. It resolves the call's policy,
 * scans what the call would send with every registered detector, records
 * per-type counts (never values) in the call's privacy scope and tells the
 * observers, and hands the call's arguments back **unchanged**. Masking and
 * restoring (`pseudonymise`, `redact`) and refusing (`block`) arrive with
 * t-992; until then a call whose policy asks for one of them is refused
 * rather than sent unprotected under a mode that promised protection.
 *
 * It refuses, and never sends, when it cannot say what the policy is: a
 * failed app init or core install (mode `off` included, because what was
 * rolled back may be what raised it), an unreadable stored mode, a policy
 * resolver that failed, or a bug in the stage itself. The opposite of the
 * guard-floor seams, on purpose.
 *
 * Nothing here logs request text or a found value.
 *
 * @see .context/privacy/llm-privacy-layer.md — *How a call flows*, *When an adapter fails*
 */
import { randomUUID } from 'node:crypto';
import { logger } from '@/lib/logging';
import { PRIVACY_REFUSED, ProviderError } from '@/lib/orchestration/llm/provider';
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import {
  createPrivacyScope,
  currentPrivacyScope,
  recordPrivacyCall,
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
  | 'mode_unavailable'
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
    'The LLM privacy layer refused the call: a required detector failed and the policy says to refuse rather than send without it.',
  mode_unavailable:
    'The LLM privacy layer refused the call: its policy asks for a mode this version cannot apply yet (pseudonymise, redact or block), and sending it unprotected would break that promise.',
  stage_error:
    'The LLM privacy layer refused the call because of an internal error. Nothing was sent. See the server log.',
};

/** A provider call the privacy stage refused. Nothing was sent. */
export class PrivacyRefusedError extends ProviderError {
  readonly reason: PrivacyRefusalReason;
  readonly providerSlug: string;
  constructor(reason: PrivacyRefusalReason, providerSlug: string) {
    super(OPERATOR_MESSAGES[reason], { code: PRIVACY_REFUSED, retriable: false });
    this.name = 'PrivacyRefusedError';
    this.reason = reason;
    this.providerSlug = providerSlug;
  }
}

/** One vendor call, as the Proxy hands it to the stage. */
export interface PrivacyStageCall {
  providerSlug: string;
  isLocal: boolean;
  coverage: Exclude<PrivacyCoverage, 'none'>;
  /** The method's arguments: `(messages, options)` for chat, `(text)` / `(texts, options)` for embeddings. */
  args: readonly unknown[];
}

/** Every string inside a parsed value, depth first: tool-call arguments. */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) stringLeaves(v, out);
  }
}

function messageTexts(messages: readonly LlmMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') out.push(m.content);
    else for (const part of m.content) if (part.type === 'text') out.push(part.text);
    // Images and documents are not scanned here: the attachments feature
    // reads them locally. Reasoning blocks are the provider's own, sent back
    // to the provider that wrote them.
    for (const call of m.toolCalls ?? []) stringLeaves(call.arguments, out);
  }
  return out;
}

/**
 * The text a call would send, as pieces in order. Joined into one input, so
 * a name tier C learns in one message is found in the others.
 */
function outboundText(call: PrivacyStageCall): string {
  const [first] = call.args;
  let pieces: string[];
  if (call.coverage === 'full') {
    pieces = Array.isArray(first) ? messageTexts(first as LlmMessage[]) : [];
  } else if (typeof first === 'string') {
    pieces = [first];
  } else {
    pieces = Array.isArray(first) ? first.filter((t): t is string => typeof t === 'string') : [];
  }
  return pieces.filter((p) => p.length > 0).join('\n\n');
}

function countByType(spans: readonly { type: EntityType }[]): Record<EntityType, number> {
  const counts: Record<EntityType, number> = {};
  for (const s of spans) counts[s.type] = (counts[s.type] ?? 0) + 1;
  return counts;
}

function scopeFor(): PrivacyScope {
  const scope = currentPrivacyScope();
  if (scope) return scope;
  // No turn or execution entered a scope: an ephemeral one for this call.
  // Its policy is the global one, never looser than a scoped call's.
  const orgId = getTenantContext()?.orgId;
  return createPrivacyScope({
    scopeId: `ephemeral:${randomUUID()}`,
    ...(orgId ? { orgId } : {}),
  });
}

function eventBase(
  scope: PrivacyScope,
  providerSlug: string
): Pick<PrivacyEvent, 'scopeId' | 'orgId' | 'agentId' | 'providerSlug'> {
  return {
    scopeId: scope.scopeId,
    ...(scope.orgId !== undefined ? { orgId: scope.orgId } : {}),
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
    providerSlug: call.providerSlug,
    ...(scope ? { scopeId: scope.scopeId } : {}),
    ...(failedAdapters.length > 0 ? { failedAdapters: [...failedAdapters] } : {}),
  });
  if (scope && mode) {
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
 * Run the stage on one call. Returns the arguments to send — in this version
 * always the ones it was given, untouched — or throws a
 * {@link PrivacyRefusedError}, in which case nothing may be sent.
 */
export async function applyPrivacyStage(call: PrivacyStageCall): Promise<readonly unknown[]> {
  let scope: PrivacyScope | undefined;
  let mode: PrivacyPolicy['mode'] | undefined;
  try {
    const adapters = getPrivacyAdapters();
    // Before the mode is even read: what failed may be what raised it.
    if (adapters.coreFailure !== null) throw refuse('core_install_failed', call, undefined, mode);
    if (adapters.appInitFailure !== null) throw refuse('app_init_failed', call, undefined, mode);

    const settings = await getOrchestrationSettings();
    // Absent (not `null`) only on a settings shape from before the column,
    // which `hydrateSettings` reads as `off` too. `null` is a stored value
    // that is not a mode, and refuses.
    const base = basePolicyFromSettings({
      privacyMode: settings.privacyMode === undefined ? 'off' : settings.privacyMode,
      privacyIgnoredEntityTypes: settings.privacyIgnoredEntityTypes ?? [],
      privacyProtectLocalProviders: settings.privacyProtectLocalProviders === true,
    });
    scope = scopeFor();
    if (base === null) throw refuse('settings_unreadable', call, scope, mode);

    // Resolvers run even when the base is `off`: one may raise it.
    const { policy, failures: resolverFailures } = await resolvePrivacyPolicy(base, {
      ...(scope.orgId !== undefined ? { orgId: scope.orgId } : {}),
      ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
      ...(scope.userId !== undefined ? { userId: scope.userId } : {}),
      providerSlug: call.providerSlug,
      isLocalProvider: call.isLocal,
    });
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

    if (policy.mode === 'off') return call.args;
    if (call.isLocal && !policy.protectLocalProviders) {
      notifyPrivacyObservers({
        ...eventBase(scope, call.providerSlug),
        mode: policy.mode,
        counts: {},
        degraded: false,
        failedAdapters: [],
        outcome: 'skipped',
      });
      return call.args;
    }
    // An embedding call is only ever counted, whatever the mode. A chat call
    // under a mode this version cannot apply is refused.
    if (call.coverage === 'full' && modeStrictness(policy.mode) > modeStrictness('detect')) {
      throw refuse('mode_unavailable', call, scope, mode);
    }

    const { spans, failures } = await runPrivacyDetectors(outboundText(call), {
      scopeId: scope.scopeId,
      ...(scope.orgId !== undefined ? { orgId: scope.orgId } : {}),
      ...(scope.agentId !== undefined ? { agentId: scope.agentId } : {}),
      knownValues: scope.knownValues,
      ignoredEntityTypes: policy.ignoredEntityTypes,
      signal: AbortSignal.timeout(PRIVACY_PASS_DEADLINE_MS),
    });
    const failedAdapters = failures.map((f) => f.adapterId);
    if (failures.some((f) => f.required) && policy.onDetectorFailure === 'block') {
      throw refuse('detector_failed', call, scope, mode, failedAdapters);
    }

    const counts = countByType(spans);
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
    return call.args;
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
