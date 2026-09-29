/**
 * Platform agents — Sunrise's own agents, defined in code (§116).
 *
 * The pattern advisor, the quiz master, the MCP dispatch identity, the
 * evaluation judges and case generator, the document clean-up assistant and
 * the provider auditors are platform machinery. They used to exist only as the
 * install org's rows, written once by eight seeds that disagreed about what
 * they owned, so a second org at `TENANCY_MODE=multi` had none of them: the
 * clean-up upload threw, MCP calls found no agent, and evaluation runs had no
 * judge.
 *
 * So each one is now a **definition** here, and every org gets its own
 * **instance** of it: an ordinary tenant row, created when the org is and
 * brought back in line with the definition on each release
 * (`reconcile-platform-agents.ts`). Nothing is shared between orgs, so every
 * §107/§108 mechanism (row isolation, caches, rate limits, budgets,
 * retention) works on them unchanged. Decided 2026-09-29 on §116, which
 * records why shared rows were abandoned.
 *
 * **What a definition owns.** Every agent field is either the platform's —
 * what the agent IS, written back by every reconcile — or the org's — how it
 * RUNS there (provider, model, spend, rate, retention), set once and then
 * left alone. The split is declared per field in the agent field registry
 * (`platformAgent` on each descriptor), not here, so a new column has to take
 * a side. A definition states the fields that differ from
 * {@link PLATFORM_AGENT_BASELINE}; the baseline supplies the rest.
 *
 * **Fork seam.** `lib/app/platform-agents.ts` registers a fork's own platform
 * agents, or replaces one of these by slug, through
 * {@link registerPlatformAgent}. The fork's init runs once, lazily, before the
 * first read, and a throwing init is rolled back (`createAppInitGate`).
 *
 * Server-only (`node:crypto`).
 */
import { createHash } from 'node:crypto';
import type { AiAgent } from '@prisma/client';

import { initAppPlatformAgents } from '@/lib/app/platform-agents';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { logger } from '@/lib/logging';
import type {
  PlatformAgentCodeOwnedField,
  PlatformAgentOrgTunableField,
} from '@/lib/orchestration/agents/agent-field-registry';
import type { TenancyClient } from '@/lib/db/tenancy-extension';
import { PATTERNS_DOCUMENT_SLUG } from '@/lib/orchestration/knowledge/patterns-knowledge';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { CASE_GENERATOR_AGENT } from '@/lib/orchestration/agents/platform-agent-definitions/case-generator';
import { CLEANUP_AGENT } from '@/lib/orchestration/agents/platform-agent-definitions/cleanup-agent';
import { EVALUATION_JUDGE_AGENTS } from '@/lib/orchestration/agents/platform-agent-definitions/evaluation-judges';
import { MCP_SYSTEM_AGENT } from '@/lib/orchestration/agents/platform-agent-definitions/mcp-system';
import {
  AUDIT_REPORT_WRITER_AGENT,
  PROVIDER_MODEL_AUDITOR_AGENT,
} from '@/lib/orchestration/agents/platform-agent-definitions/model-auditor';
import { PATTERN_ADVISOR_AGENT } from '@/lib/orchestration/agents/platform-agent-definitions/pattern-advisor';
import { QUIZ_MASTER_AGENT } from '@/lib/orchestration/agents/platform-agent-definitions/quiz-master';
import { RAG_EVALUATION_JUDGE_AGENTS } from '@/lib/orchestration/agents/platform-agent-definitions/rag-evaluation-judges';

/**
 * Code-owned fields a definition may NOT set: `slug` is the entry's own key,
 * and the two JSON columns and the profile link have no platform agent that
 * uses them, so the baseline's `null` is the only value.
 */
type UnsettableField = 'slug' | 'metadata' | 'widgetConfig' | 'profileId';

/** The code-owned fields every definition must state. */
type RequiredField = 'name' | 'description' | 'systemInstructions' | 'temperature' | 'maxTokens';

/** Code-owned fields the baseline supplies when a definition does not. */
export type PlatformAgentBaselineField = Exclude<
  PlatformAgentCodeOwnedField,
  'slug' | RequiredField
>;

/** Who gets an instance of a platform agent. */
export type PlatformAgentAudience =
  /** Every org — the default. */
  | 'every-org'
  /**
   * The install org only. For an agent whose work is the install's, not a
   * tenant's: the provider auditors write the provider-model catalogue every
   * org reads, so an org other than install must not be able to run them.
   */
  | 'install-only';

/** A provider/model pair an org's instance may start with. */
export interface PlatformAgentBinding {
  provider: string;
  model: string;
}

export interface PlatformAgentDefinition {
  /** The agent's slug in every org. Unique in the registry. */
  slug: string;
  audience: PlatformAgentAudience;
  /**
   * What the agent is: every code-owned field that differs from
   * {@link PLATFORM_AGENT_BASELINE}. Written back by every reconcile.
   */
  agent: Pick<AiAgent, RequiredField> &
    Partial<Pick<AiAgent, Exclude<PlatformAgentBaselineField, UnsettableField>>>;
  /**
   * The capability slugs the agent is bound to, all enabled. Authoritative: a
   * reconcile removes any other binding. A slug with no capability row yet is
   * skipped with a warning (the capability seeds may not have run).
   */
  capabilities: readonly string[];
  /**
   * Whose the binding rows are. `'platform'` (the default) makes
   * `capabilities` authoritative. `'org'` leaves every binding row to the org:
   * a reconcile creates, removes and re-enables none, and `capabilities` must
   * be empty. For an agent with no tool set of its own — `mcp-system`
   * dispatches whatever the MCP Tools page exposes, and under
   * `CAPABILITY_BINDING_MODE=strict` an operator grants it tools by adding
   * binding rows, which a platform-owned set would delete.
   */
  capabilityBindings?: 'platform' | 'org';
  /**
   * The knowledge-tag slugs granted to the agent. Authoritative, like
   * `capabilities`; document grants are always empty on a platform agent.
   */
  knowledgeTags: readonly string[];
  /**
   * Org-tunable values an instance starts with instead of the schema's
   * defaults. Applied when the instance is created, never after.
   * (`providerConfig` is left to the org: it belongs to whichever provider the
   * org picks.)
   */
  defaults?: Partial<Pick<AiAgent, Exclude<PlatformAgentOrgTunableField, 'providerConfig'>>>;
  /**
   * A provider and model to pin while the org has chosen neither. Consulted
   * when the instance is created, and on each reconcile while BOTH are still
   * empty (the "inherit at runtime" contract of `agent-resolver.ts`) — so an
   * org's own choice is never overwritten. Returns `null` to keep inheriting.
   */
  defaultBinding?: (db: TenancyClient) => Promise<PlatformAgentBinding | null>;
}

/**
 * The value of every code-owned field a definition leaves out. These are the
 * schema's own defaults, written down once so a reconcile can put a field BACK
 * to its default — a definition that stops setting `persona` must clear the
 * persona it set before, and an org's edit to a field the definition never set
 * is still the platform's to undo.
 *
 * Exhaustive by construction: a new code-owned column is a compile error here
 * until it has a baseline.
 */
export const PLATFORM_AGENT_BASELINE = {
  isActive: true,
  visibility: 'internal',
  kind: 'chat',
  knowledgeAccessMode: 'full',
  knowledgeRetrievalMode: 'model',
  knowledgeTriggerKeywords: [],
  topicBoundaries: [],
  runtimePromptManaged: false,
  runtimePromptNote: null,
  reasoningEffort: null,
  maxHistoryTokens: null,
  maxHistoryMessages: null,
  inputGuardMode: null,
  outputGuardMode: null,
  citationGuardMode: null,
  persona: null,
  brandVoiceInstructions: null,
  guardrails: null,
  personaMode: 'override',
  voiceMode: 'override',
  guardrailsMode: 'override',
  enableVoiceInput: false,
  enableImageInput: false,
  enableDocumentInput: false,
  metadata: null,
  widgetConfig: null,
  profileId: null,
} satisfies Pick<AiAgent, PlatformAgentBaselineField>;

/** Sunrise's own platform agents, in the order the seeds used to create them. */
export const CORE_PLATFORM_AGENTS: readonly PlatformAgentDefinition[] = [
  PATTERN_ADVISOR_AGENT,
  QUIZ_MASTER_AGENT,
  MCP_SYSTEM_AGENT,
  PROVIDER_MODEL_AUDITOR_AGENT,
  AUDIT_REPORT_WRITER_AGENT,
  ...EVALUATION_JUDGE_AGENTS,
  CASE_GENERATOR_AGENT,
  ...RAG_EVALUATION_JUDGE_AGENTS,
  CLEANUP_AGENT,
];

function coreRegistry(): Map<string, PlatformAgentDefinition> {
  return new Map(CORE_PLATFORM_AGENTS.map((definition) => [definition.slug, definition]));
}

const registry = coreRegistry();

/**
 * The digest of the registry as it stands after the fork's init. Nothing
 * changes the registry after that but a later `registerPlatformAgent` call,
 * which clears it; the maintenance job compares it once per org per run.
 */
let cachedHash: string | null = null;

/**
 * A fork replacing a core slug changes an agent every org runs while changing
 * nothing an admin can see, so it is named in the log (the grader registry's
 * precedent).
 */
const appInit = createAppInitGate({
  label: 'platform-agents: initAppPlatformAgents',
  subject: 'app platform agents',
  init: initAppPlatformAgents,
  snapshot: () => new Map(registry),
  restore: (before) => restoreMap(registry, before),
  onSuccess: (before) => {
    for (const [slug, definition] of before) {
      if (registry.get(slug) !== definition) {
        logger.warn('platform-agents: an app definition replaced a core platform agent', { slug });
      }
    }
  },
});

/**
 * Register a platform agent, or replace one by slug. Called from a fork's
 * `initAppPlatformAgents()`; the next reconcile materialises it in every org
 * it is for.
 */
export function registerPlatformAgent(definition: PlatformAgentDefinition): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(definition.slug)) {
    throw new Error(`Platform agent slug "${definition.slug}" must be lowercase kebab-case`);
  }
  for (const [list, values] of [
    ['capabilities', definition.capabilities],
    ['knowledgeTags', definition.knowledgeTags],
  ] as const) {
    // A repeat would meet the binding or grant's unique key inside the create
    // transaction, which the reconcile would take for a concurrent run.
    if (new Set(values).size !== values.length) {
      throw new Error(`Platform agent "${definition.slug}" repeats a slug in ${list}`);
    }
  }
  if (definition.capabilityBindings === 'org' && definition.capabilities.length > 0) {
    throw new Error(
      `Platform agent "${definition.slug}" leaves its bindings to the org, so it cannot declare capabilities`
    );
  }
  registry.set(definition.slug, definition);
  cachedHash = null;
}

/** Every registered platform agent, core and fork, in registration order. */
export function listPlatformAgents(): readonly PlatformAgentDefinition[] {
  appInit.ensure();
  return Array.from(registry.values());
}

/**
 * The registered definition for a slug, or `undefined`. Every org's audience
 * is ignored: a slug is a platform slug everywhere, whether or not this org
 * gets an instance of it.
 */
export function getPlatformAgent(slug: string): PlatformAgentDefinition | undefined {
  appInit.ensure();
  return registry.get(slug);
}

/** The platform agents an org gets an instance of. */
export function platformAgentsForOrg(orgId: string): readonly PlatformAgentDefinition[] {
  return listPlatformAgents().filter(
    (definition) => definition.audience === 'every-org' || orgId === INSTALL_ORG_ID
  );
}

/**
 * A digest of everything a reconcile writes from: every definition, the
 * baseline, and the version of the patterns knowledge each org gets a copy of
 * (its document slug carries the content hash). An org whose stored digest
 * differs is behind the running code and is reconciled by the maintenance job.
 *
 * `defaultBinding` is a function, so only its presence is hashed — it decides
 * a starting value, which a later change to it could not rewrite anyway.
 */
export function platformAgentRegistryHash(): string {
  const registered = listPlatformAgents();
  cachedHash ??= computeRegistryHash(registered);
  return cachedHash;
}

function computeRegistryHash(registered: readonly PlatformAgentDefinition[]): string {
  const definitions = [...registered]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map(({ defaultBinding, ...rest }) => ({ ...rest, defaultBinding: Boolean(defaultBinding) }));
  return createHash('sha256')
    .update(
      JSON.stringify({
        baseline: PLATFORM_AGENT_BASELINE,
        definitions,
        patternsKnowledge: PATTERNS_DOCUMENT_SLUG,
      })
    )
    .digest('hex');
}

/** Test-only: back to the core registry, with the fork init re-armed. */
export function __resetPlatformAgentsForTests(): void {
  restoreMap(registry, coreRegistry());
  appInit.reset();
  cachedHash = null;
}
