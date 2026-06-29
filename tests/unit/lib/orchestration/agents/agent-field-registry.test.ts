/**
 * agent-field-registry — exhaustiveness, internal invariants, and a divergence
 * ledger against the hand-maintained lists this registry will replace.
 *
 * PR 1 adds the registry but does NOT yet route any runtime through it, so the
 * existing lists still drive behaviour. These tests prove the registry faithfully
 * *supersedes* those lists and pin — as explicit, asserted data — exactly where
 * the current lists have drifted (the historic bugs). When later PRs switch each
 * consumer to the registry, the corresponding ledger delta drops to empty and the
 * fixture below is trimmed.
 */
import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  AGENT_FIELDS,
  fieldLabels,
  fieldOrder,
  fieldToTab,
  getAgentField,
  snapshotFieldNames,
  versionedFieldNames,
  versionedScalarFieldNames,
} from '@/lib/orchestration/agents/agent-field-registry';
import {
  buildChangeSummary,
  labelForField,
  SNAPSHOT_FIELDS,
} from '@/lib/orchestration/agent-version-diff';
import { updateAgentObjectSchema } from '@/lib/validations/orchestration';

// ---------------------------------------------------------------------------
// Characterisation fixtures — verbatim snapshots of the current hand-lists as of
// the PR that introduces this registry. They are the "before" the ledger asserts
// against; deleting one without flipping the corresponding consumer to the
// registry is the regression we're guarding.
// ---------------------------------------------------------------------------

/** `agent-version-diff.ts` FIELD_ORDER (module-private; copied as a fixture). */
const CURRENT_FIELD_ORDER = [
  'name',
  'slug',
  'description',
  'isActive',
  'visibility',
  'model',
  'provider',
  'fallbackProviders',
  'systemInstructions',
  'runtimePromptManaged',
  'runtimePromptNote',
  'temperature',
  'maxTokens',
  'maxHistoryTokens',
  'maxHistoryMessages',
  'monthlyBudgetUsd',
  'rateLimitRpm',
  'retentionDays',
  'inputGuardMode',
  'outputGuardMode',
  'citationGuardMode',
  'topicBoundaries',
  'brandVoiceInstructions',
  'knowledgeAccessMode',
  'knowledgeRetrievalMode',
  'knowledgeTriggerKeywords',
  'grantedTagIds',
  'grantedDocumentIds',
  'enableVoiceInput',
  'enableImageInput',
  'enableDocumentInput',
  'providerConfig',
  'metadata',
];

/** PATCH route VERSIONED_FIELDS (handler-private; copied as a fixture). */
const CURRENT_VERSIONED_FIELDS = [
  'name',
  'slug',
  'description',
  'isActive',
  'systemInstructions',
  'model',
  'temperature',
  'maxTokens',
  'topicBoundaries',
  'brandVoiceInstructions',
  'provider',
  'fallbackProviders',
  'knowledgeAccessMode',
  'knowledgeRetrievalMode',
  'knowledgeTriggerKeywords',
  'rateLimitRpm',
  'visibility',
  'inputGuardMode',
  'outputGuardMode',
  'citationGuardMode',
  'maxHistoryTokens',
  'maxHistoryMessages',
  'retentionDays',
  'providerConfig',
  'monthlyBudgetUsd',
  'maxCostPerTurnUsd',
  'metadata',
  'enableVoiceInput',
  'enableImageInput',
  'enableDocumentInput',
  'runtimePromptManaged',
  'runtimePromptNote',
  'persona',
  'guardrails',
  'personaMode',
  'voiceMode',
  'guardrailsMode',
];

/** AiAgent columns deliberately excluded from the registry (audit/system/derived). */
const NON_CONFIG_SCALARS = [
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'lastActiveAt',
  'createdBy',
  'isSystem',
  'systemInstructionsHistory',
];

const sortedSet = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const diff = (a: string[], b: string[]): string[] => a.filter((x) => !b.includes(x)).sort();

describe('agent-field-registry — exhaustiveness against Prisma', () => {
  it('every AiAgent scalar column is either a registered config field or an explicit exclusion', () => {
    const allScalarColumns = Object.keys(Prisma.AiAgentScalarFieldEnum);
    const registeredScalars = AGENT_FIELDS.filter((f) => f.kind === 'scalar').map((f) => f.name);

    // No column is silently dropped, and no registered scalar is misspelled /
    // absent from the model. (The `satisfies` check in the registry enforces this
    // at compile time too; this is the runtime belt-and-braces + guards the
    // exclusion list.)
    expect(sortedSet([...registeredScalars, ...NON_CONFIG_SCALARS])).toEqual(
      sortedSet(allScalarColumns)
    );
  });

  it('excluded columns are not registered as fields', () => {
    const names = new Set(AGENT_FIELDS.map((f) => f.name));
    for (const excluded of NON_CONFIG_SCALARS) {
      expect(names.has(excluded)).toBe(false);
    }
  });
});

describe('agent-field-registry — internal invariants', () => {
  it('field names are unique', () => {
    const names = AGENT_FIELDS.map((f) => f.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it('a field is versioned iff it carries ui metadata', () => {
    for (const f of AGENT_FIELDS) {
      expect(f.versioned).toBe(f.ui !== undefined);
    }
  });

  it('ui order values are unique (a stable total order)', () => {
    const orders = AGENT_FIELDS.filter((f) => f.ui).map((f) => f.ui!.order);
    expect(orders.length).toBe(new Set(orders).size);
  });

  it('snapshot whitelist equals the versioned set (no "versioned but not snapshotted")', () => {
    expect(snapshotFieldNames()).toEqual(versionedFieldNames());
  });

  it('getAgentField resolves by name', () => {
    expect(getAgentField('temperature')?.versioned).toBe(true);
    expect(getAgentField('kind')?.versioned).toBe(false);
    expect(getAgentField('nope')).toBeUndefined();
  });
});

describe('agent-field-registry — divergence ledger vs current hand-lists', () => {
  it('preserves the existing relative field order', () => {
    const derivedForCurrentFields = fieldOrder().filter((f) => CURRENT_FIELD_ORDER.includes(f));
    expect(derivedForCurrentFields).toEqual(CURRENT_FIELD_ORDER);
  });

  it('reproduces every current diff label exactly', () => {
    const labels = fieldLabels();
    for (const field of SNAPSHOT_FIELDS) {
      expect(labels[field]).toBe(labelForField(field));
    }
  });

  it('reproduces every current tab assignment exactly', () => {
    const tabs = fieldToTab();
    for (const field of SNAPSHOT_FIELDS) {
      // buildChangeSummary([field]) renders as `${tab}: ${label}`.
      const summary = buildChangeSummary([field]);
      const currentTab = summary.slice(0, summary.indexOf(':'));
      expect(tabs[field]).toBe(currentTab);
    }
  });

  it('agent-version-diff SNAPSHOT_FIELDS is wired to the registry (ledger delta closed)', () => {
    // This consumer now derives from the registry, so the snapshot whitelist and
    // the diff maps are the registry's versioned set by construction — the
    // historic "versioned but not snapshotted" gap (persona/guardrails/*Mode,
    // reasoningEffort, maxCostPerTurnUsd) can no longer reopen.
    expect([...SNAPSHOT_FIELDS].sort()).toEqual(versionedFieldNames().sort());
  });

  it('supersedes the legacy VERSIONED_FIELDS — adds exactly the fields missing from the old versioned set', () => {
    const registry = versionedFieldNames();
    // Everything currently versioned stays versioned...
    expect(diff(CURRENT_VERSIONED_FIELDS, registry)).toEqual([]);
    // ...plus reasoningEffort (user config, never versioned) and the two grant
    // relations (snapshotted but absent from VERSIONED_FIELDS).
    expect(diff(registry, CURRENT_VERSIONED_FIELDS)).toEqual(
      ['grantedDocumentIds', 'grantedTagIds', 'reasoningEffort'].sort()
    );
  });
});

describe('agent-field-registry — parity with the validation schemas', () => {
  // Fields the registry has but the PATCH schema deliberately omits:
  //  - kind: set at create, immutable thereafter (create-only)
  //  - widgetConfig: managed via its own endpoint, not the agent PATCH body
  const PATCH_OMITTED = new Set(['kind', 'widgetConfig']);

  it('every versioned scalar field exists on updateAgentObjectSchema (so restore can validate it)', () => {
    const updateKeys = new Set(Object.keys(updateAgentObjectSchema.shape));
    for (const field of versionedScalarFieldNames()) {
      expect(updateKeys.has(field)).toBe(true);
    }
  });

  it('registry scalars and the PATCH schema field set agree in both directions (drift guard)', () => {
    const updateKeys = new Set(Object.keys(updateAgentObjectSchema.shape));
    const registryScalars = AGENT_FIELDS.filter((f) => f.kind === 'scalar').map((f) => f.name);
    const registryNames = new Set(AGENT_FIELDS.map((f) => f.name));

    // Every registry scalar (except the documented PATCH-omitted ones) is a
    // PATCH field — catches a registered field with no validation surface.
    for (const field of registryScalars) {
      if (PATCH_OMITTED.has(field)) continue;
      expect(updateKeys.has(field)).toBe(true);
    }

    // Every PATCH field is registered — catches a schema field with no
    // descriptor (the silent-gap this whole registry exists to prevent).
    for (const key of updateKeys) {
      expect(registryNames.has(key)).toBe(true);
    }
  });
});
