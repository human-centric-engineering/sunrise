/**
 * The agent's and the org's own LLM privacy settings (§127, t-1010): an
 * agent's mode (`AiAgent.privacyMode`), and an org's minimum mode and
 * protected terms (`Org.settings.privacy`).
 *
 * The two modes reach a call through core's policy resolver,
 * {@link scopeSettingsResolver}, registered with the others in
 * `lib/privacy/adapters/core-defaults.ts`. Like every resolver, it can only
 * tighten: the call runs under the strictest of the install's mode, the
 * agent's and the org's, whichever order they are applied in. The protected
 * terms reach tier B as known values; the stage gathers them.
 *
 * **Read once per privacy scope**, not per call and not cached across scopes.
 * A turn's tool loop makes many provider calls, each running the resolver;
 * the read is kept on the scope (`PrivacyScope.scopeSettings`), like its token
 * session, and gone with it. So a change applies from the next turn or step,
 * and a turn never changes mode part-way through. A call with no scope reads
 * each time. Nothing is held at module level.
 *
 * **Fails closed.** A stored mode that is not a mode, or an org slice that
 * cannot be read, throws: the resolver then fails and the stage refuses the
 * call (`policy_resolver_failed`), rather than send it looser than someone
 * asked. The log line says which row, and what to do about it.
 *
 * @see .context/privacy/llm-privacy-layer.md — *Settings*
 */
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { currentPrivacyScope, type PrivacyScope } from '@/lib/orchestration/privacy/scope';
import {
  parseTighteningMode,
  type PrivacyTighteningMode,
} from '@/lib/orchestration/privacy/settings-policy';
import { stricterMode } from '@/lib/privacy/adapters/policy';
import type { KnownValue, PrivacyPolicyResolver } from '@/lib/privacy/adapters/types';
import { readOrgPrivacy } from '@/lib/tenancy/org-settings';

/**
 * The resolver's id. `core.` like every core adapter, so an app can neither
 * register it nor replace it (resolvers take no `replace`); an app's own
 * resolvers run beside it and can only tighten further.
 */
export const SCOPE_SETTINGS_RESOLVER_ID = 'core.scope-settings';

/** What the agent and the org a call is for have chosen. */
export interface ScopePrivacySettings {
  /** The agent's own mode, or `null` to use the install's. */
  agentMode: PrivacyTighteningMode | null;
  /** The org's minimum mode, or `null` for none. */
  orgMinimumMode: PrivacyTighteningMode | null;
  /** The org's protected terms, as tier B's known values. */
  protectedTerms: readonly KnownValue[];
}

const NOTHING_CHOSEN: ScopePrivacySettings = {
  agentMode: null,
  orgMinimumMode: null,
  protectedTerms: [],
};

/** Who a call is for. */
export interface ScopeSettingsKey {
  orgId?: string;
  agentId?: string;
}

/** Thrown when a stored setting cannot be read. Its message names no value. */
export class ScopePrivacySettingsUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopePrivacySettingsUnreadableError';
  }
}

async function load({ orgId, agentId }: ScopeSettingsKey): Promise<ScopePrivacySettings> {
  if (orgId === undefined && agentId === undefined) return NOTHING_CHOSEN;
  // `AiAgent` is org-scoped: read in the caller's tenant context, which is
  // the org the call is for. An agent that is gone sets nothing.
  const [agent, org] = await Promise.all([
    agentId === undefined
      ? null
      : prisma.aiAgent.findUnique({ where: { id: agentId }, select: { privacyMode: true } }),
    orgId === undefined
      ? null
      : prisma.org.findUnique({ where: { id: orgId }, select: { settings: true } }),
  ]);

  let agentMode: PrivacyTighteningMode | null;
  try {
    agentMode = parseTighteningMode(agent?.privacyMode);
  } catch {
    logger.warn(
      'privacy: an agent’s stored privacy mode is not a mode; its calls are refused until one is chosen on the agent form',
      { agentId }
    );
    throw new ScopePrivacySettingsUnreadableError('stored agent privacy mode is not a mode');
  }

  if (!org) return { agentMode, orgMinimumMode: null, protectedTerms: [] };
  const read = readOrgPrivacy(org.settings);
  if (!read.ok) {
    logger.warn(
      'privacy: an org’s privacy settings cannot be read; its calls are refused until they are saved again on the organisation page',
      { orgId, issues: read.issues }
    );
    throw new ScopePrivacySettingsUnreadableError('stored org privacy settings are unreadable');
  }
  return {
    agentMode,
    orgMinimumMode: read.value.minimumMode,
    protectedTerms: read.value.protectedTerms.map((term) => ({
      type: term.type,
      value: term.value,
    })),
  };
}

/**
 * The settings for `key`, read once per `scope` (see the module docblock).
 * Without a scope, read now. A read that fails is not kept, so the next call
 * asks again.
 */
export function scopePrivacySettings(
  key: ScopeSettingsKey,
  scope: PrivacyScope | undefined = currentPrivacyScope()
): Promise<ScopePrivacySettings> {
  if (!scope) return load(key);
  // A chat turn binds its agent after entering its scope, so the key can
  // change once; the read follows it.
  const memoKey = `${key.orgId ?? ''}\u0000${key.agentId ?? ''}`;
  if (scope.scopeSettings?.key === memoKey) return scope.scopeSettings.value;
  const value = load(key);
  const entry = { key: memoKey, value };
  scope.scopeSettings = entry;
  value.catch(() => {
    if (scope.scopeSettings === entry) delete scope.scopeSettings;
  });
  return value;
}

/** The stricter of the modes set, or `null` when neither is. */
export function strictestChosenMode(
  settings: Pick<ScopePrivacySettings, 'agentMode' | 'orgMinimumMode'>
): PrivacyTighteningMode | null {
  const { agentMode, orgMinimumMode } = settings;
  if (agentMode === null || orgMinimumMode === null) return agentMode ?? orgMinimumMode;
  // The one strictness order (`stricterMode`); both are tightening modes, so
  // whichever it picks is one too.
  return stricterMode(agentMode, orgMinimumMode) === agentMode ? agentMode : orgMinimumMode;
}

/**
 * Core's policy resolver: raises the mode to the agent's, then to the org's
 * minimum. Only ever raises it; the registry keeps the stricter value anyway.
 */
export function scopeSettingsResolver(): PrivacyPolicyResolver {
  return {
    id: SCOPE_SETTINGS_RESOLVER_ID,
    async resolve(input) {
      const settings = await scopePrivacySettings({
        ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
        ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
      });
      const mode = strictestChosenMode(settings);
      return mode === null ? undefined : { mode };
    },
  };
}
