/**
 * agent-field-registry — the single source of truth for `AiAgent` config fields.
 *
 * ## Why this exists
 *
 * Historically, adding one field to `AiAgent` meant editing ~15 disconnected,
 * hand-maintained lists (validation schemas, the create/PATCH/clone/import data
 * mappings, `VERSIONED_FIELDS`, the snapshot writer, the four `agent-version-diff`
 * maps, the export bundle…). Nothing tied them together, so forgetting one
 * produced a **silent** behavioural gap — no type error, no test failure. The
 * lists had already drifted out of sync on `main` (see the divergence ledger in
 * `agent-field-registry.test.ts`).
 *
 * This module replaces those scattered lists with one declarative descriptor per
 * field. Each subsystem derives its list from here, so:
 *
 *   - Adding a field is **one descriptor** (plus the Prisma column it mirrors).
 *   - Forgetting a surface is a **compile error**, not a silent runtime gap.
 *   - A change can never be "versioned but not snapshotted", because the snapshot
 *     set and the versioned set are the *same* derived list.
 *
 * ## Scope of THIS file (PR 1)
 *
 * PR 1 lands the registry foundation and makes it the source of truth for the
 * **versioning / diff surfaces** (`VERSIONED_FIELDS`, the snapshot whitelist, and
 * the `agent-version-diff` label/tab/order maps). Nothing consumes the registry at
 * runtime yet — the existing hand-lists still drive behaviour — so this PR is
 * behaviour-neutral. Later PRs route the snapshot writer, restore, clone, export/
 * import, and the Zod schemas through it (and the per-field `validator` / `clone`
 * / `export` descriptor fields arrive with those phases).
 *
 * ## Fork extension
 *
 * Forks add their own agent fields in `lib/app/agent-fields.ts` (a fork-owned
 * scaffold) — `AGENT_FIELDS` is `[...CORE_AGENT_FIELDS, ...appAgentFields]`, so a
 * fork never edits this file and never conflicts with upstream on a field add.
 */
import type { Prisma } from '@prisma/client';

import { appAgentFields } from '@/lib/app/agent-fields';

/**
 * Form tab a field is grouped under in the version-diff change summary. This is
 * the 3-bucket simplification the diff viewer uses — the live agent form has more
 * tabs, but the history headline collapses to these. Keep aligned with
 * `components/admin/orchestration/agent-form.tsx`'s grouping.
 */
export type AgentFieldTab = 'General' | 'Model' | 'Instructions';

/** Version-diff / form-grouping metadata. Present iff the field is versioned. */
export interface AgentFieldUi {
  /** Human-readable label shown in the version-diff table. */
  label: string;
  /** Which form tab the field belongs to (drives the change-summary headline). */
  tab: AgentFieldTab;
  /** Stable display order in the diff table — lower sorts first. */
  order: number;
}

/** One agent config field's cross-cutting policy. */
export interface AgentFieldDescriptor {
  /** Matches the `AiAgent` column (`kind: 'scalar'`) or the grant relation key. */
  name: string;
  /**
   * `'scalar'` — a column on `AiAgent`.
   * `'relation'` — a knowledge grant materialised via a join table
   * (`grantedTagIds` / `grantedDocumentIds`), captured in snapshots by value but
   * not a column on `AiAgent`.
   */
  kind: 'scalar' | 'relation';
  /**
   * Whether a change to this field creates a version row, is captured in the
   * `AiAgentVersion` snapshot, appears in the diff, and is applied on restore.
   * The snapshot whitelist and the versioned set are intentionally the *same*
   * list — that unification is what fixes the historic "versioned but not
   * snapshotted" class of bug.
   */
  versioned: boolean;
  /** Diff/form metadata — present iff `versioned` (enforced by a registry test). */
  ui?: AgentFieldUi;
  /**
   * Special write handling in the create/PATCH data mapping. Plain column
   * assignment when absent. `'relation'` = written via a Prisma connect/
   * disconnect (`profileId`); `'historyTracked'` = pushes the prior value onto a
   * history column before overwriting (`systemInstructions`). These fields are
   * excluded from the generic plain-assignment loop and handled explicitly.
   */
  write?: 'relation' | 'historyTracked';
  /**
   * Excluded from the PATCH update body — either create-only and immutable
   * (`kind`) or managed through a dedicated endpoint (`widgetConfig`).
   */
  patchOmit?: true;
  /**
   * The column is a Prisma `Json` type. Server-side write paths coerce a null
   * value to `Prisma.JsonNull` on create. (The coercion itself lives in the
   * route — this flag stays data-only so the registry never imports the Prisma
   * runtime and remains safe to bundle into client components.)
   */
  json?: true;
}

/**
 * `AiAgent` columns that are NOT user-editable config: audit/system/derived
 * columns excluded from the registry. Anything else in the scalar enum MUST have
 * a descriptor below, or `CORE_SCALAR_FIELDS` won't type-check.
 */
type NonConfigScalar =
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'lastActiveAt'
  | 'createdBy'
  | 'isSystem'
  | 'systemInstructionsHistory';

/**
 * Every editable scalar config field on `AiAgent`. Derived from Prisma's
 * generated scalar-field enum, so adding a column to the model widens this union
 * and forces a new descriptor (or an explicit `NonConfigScalar` exclusion).
 */
export type AgentConfigScalarField = Exclude<
  keyof typeof Prisma.AiAgentScalarFieldEnum,
  NonConfigScalar
>;

/** Per-scalar spec (everything except `name`/`kind`, which are filled in below). */
type ScalarFieldSpec = Omit<AgentFieldDescriptor, 'name' | 'kind'>;

/**
 * The scalar config fields. Keyed by field name and `satisfies`-checked against
 * `AgentConfigScalarField`, so this object is **exhaustive by construction**:
 * a missing field, an extra field, or a typo is a compile error.
 *
 * `order` values are spaced so fork/inserted fields slot between without
 * renumbering. `versioned` + `ui` encode the *intended* truth; where that
 * differs from today's hand-lists, the gap is a known bug pinned in
 * `agent-field-registry.test.ts` (and closed when consumers switch over).
 */
const CORE_SCALAR_FIELDS = {
  name: { versioned: true, ui: { label: 'Name', tab: 'General', order: 10 } },
  slug: { versioned: true, ui: { label: 'Slug', tab: 'General', order: 20 } },
  description: { versioned: true, ui: { label: 'Description', tab: 'General', order: 30 } },
  isActive: { versioned: true, ui: { label: 'Active', tab: 'General', order: 40 } },
  visibility: { versioned: true, ui: { label: 'Visibility', tab: 'General', order: 50 } },
  model: { versioned: true, ui: { label: 'Model', tab: 'Model', order: 60 } },
  provider: { versioned: true, ui: { label: 'Provider', tab: 'Model', order: 70 } },
  fallbackProviders: {
    versioned: true,
    ui: { label: 'Fallback providers', tab: 'Model', order: 80 },
  },
  systemInstructions: {
    versioned: true,
    ui: { label: 'System instructions', tab: 'Instructions', order: 90 },
    write: 'historyTracked',
  },
  runtimePromptManaged: {
    versioned: true,
    ui: { label: 'Runtime-built prompt', tab: 'Instructions', order: 100 },
  },
  runtimePromptNote: {
    versioned: true,
    ui: { label: 'Runtime prompt note', tab: 'Instructions', order: 110 },
  },
  temperature: { versioned: true, ui: { label: 'Temperature', tab: 'Model', order: 120 } },
  maxTokens: { versioned: true, ui: { label: 'Max output tokens', tab: 'Model', order: 130 } },
  // Truth fix: reasoningEffort is user config and was written to the snapshot but
  // omitted from VERSIONED_FIELDS and every diff map — invisible in history today.
  reasoningEffort: {
    versioned: true,
    ui: { label: 'Reasoning effort', tab: 'Model', order: 135 },
  },
  maxHistoryTokens: {
    versioned: true,
    ui: { label: 'Max history tokens', tab: 'Model', order: 140 },
  },
  maxHistoryMessages: {
    versioned: true,
    ui: { label: 'Memory length (messages)', tab: 'Model', order: 150 },
  },
  monthlyBudgetUsd: {
    versioned: true,
    ui: { label: 'Monthly budget (USD)', tab: 'Model', order: 160 },
  },
  // Truth fix: in VERSIONED_FIELDS + the snapshot writer, but absent from the diff
  // maps — a change was tracked yet unrenderable.
  maxCostPerTurnUsd: {
    versioned: true,
    ui: { label: 'Per-turn cost cap (USD)', tab: 'Model', order: 165 },
  },
  rateLimitRpm: {
    versioned: true,
    ui: { label: 'Rate limit (req/min)', tab: 'Model', order: 170 },
  },
  retentionDays: { versioned: true, ui: { label: 'Retention (days)', tab: 'General', order: 180 } },
  inputGuardMode: { versioned: true, ui: { label: 'Input guard', tab: 'Model', order: 190 } },
  outputGuardMode: { versioned: true, ui: { label: 'Output guard', tab: 'Model', order: 200 } },
  citationGuardMode: {
    versioned: true,
    ui: { label: 'Citation guard', tab: 'Model', order: 210 },
  },
  topicBoundaries: {
    versioned: true,
    ui: { label: 'Topic boundaries', tab: 'Instructions', order: 220 },
  },
  brandVoiceInstructions: {
    versioned: true,
    ui: { label: 'Brand voice', tab: 'Instructions', order: 230 },
  },
  // Truth fix (persona/guardrails/*Mode): all five are in VERSIONED_FIELDS — so
  // editing them logs a "changed" version — yet none were written to the snapshot,
  // none are in the diff maps, and none are applied on restore. History claimed a
  // change it never captured or recovered. They become versioned + renderable here.
  persona: { versioned: true, ui: { label: 'Persona', tab: 'Instructions', order: 232 } },
  personaMode: { versioned: true, ui: { label: 'Persona mode', tab: 'Instructions', order: 234 } },
  voiceMode: { versioned: true, ui: { label: 'Voice mode', tab: 'Instructions', order: 236 } },
  guardrails: { versioned: true, ui: { label: 'Guardrails', tab: 'Instructions', order: 238 } },
  guardrailsMode: {
    versioned: true,
    ui: { label: 'Guardrails mode', tab: 'Instructions', order: 239 },
  },
  knowledgeAccessMode: {
    versioned: true,
    ui: { label: 'Knowledge access mode', tab: 'Instructions', order: 240 },
  },
  knowledgeRetrievalMode: {
    versioned: true,
    ui: { label: 'Knowledge retrieval mode', tab: 'Instructions', order: 250 },
  },
  knowledgeTriggerKeywords: {
    versioned: true,
    ui: { label: 'Knowledge trigger keywords', tab: 'Instructions', order: 260 },
  },
  enableVoiceInput: { versioned: true, ui: { label: 'Voice input', tab: 'Model', order: 290 } },
  enableImageInput: { versioned: true, ui: { label: 'Image input', tab: 'Model', order: 300 } },
  enableDocumentInput: {
    versioned: true,
    ui: { label: 'Document input', tab: 'Model', order: 310 },
  },
  providerConfig: {
    versioned: true,
    ui: { label: 'Provider config', tab: 'Model', order: 320 },
    json: true,
  },
  metadata: { versioned: true, ui: { label: 'Metadata', tab: 'Model', order: 330 }, json: true },
  // Not versioned. `profileId` is a relation pointer, not content — the
  // inheritance change surfaces implicitly through the resolved persona/voice/
  // guardrails values (see the PATCH route's VERSIONED_FIELDS note). `kind` is
  // immutable after create. `widgetConfig` carries embed presentation only.
  profileId: { versioned: false, write: 'relation' },
  kind: { versioned: false, patchOmit: true },
  widgetConfig: { versioned: false, patchOmit: true, json: true },
} satisfies Record<AgentConfigScalarField, ScalarFieldSpec>;

/**
 * Knowledge-grant relations. Not columns on `AiAgent` (they live in join tables),
 * so they're outside the scalar-enum exhaustiveness check and declared explicitly.
 * Both are captured by value in the snapshot, so they're versioned.
 */
const CORE_RELATION_FIELDS: readonly AgentFieldDescriptor[] = [
  {
    name: 'grantedTagIds',
    kind: 'relation',
    versioned: true,
    ui: { label: 'Knowledge tag grants', tab: 'Instructions', order: 270 },
  },
  {
    name: 'grantedDocumentIds',
    kind: 'relation',
    versioned: true,
    ui: { label: 'Knowledge document grants', tab: 'Instructions', order: 280 },
  },
];

/** The platform's agent field descriptors. Forks extend via `appAgentFields`. */
export const CORE_AGENT_FIELDS: readonly AgentFieldDescriptor[] = [
  ...Object.entries(CORE_SCALAR_FIELDS).map(
    ([name, spec]): AgentFieldDescriptor => ({ name, kind: 'scalar', ...spec })
  ),
  ...CORE_RELATION_FIELDS,
];

/**
 * The full agent field registry: platform fields plus any fork-owned fields from
 * `lib/app/agent-fields.ts`. This is the list every derived selector reads.
 */
export const AGENT_FIELDS: readonly AgentFieldDescriptor[] = [
  ...CORE_AGENT_FIELDS,
  ...appAgentFields,
];

/**
 * Sort comparator by `ui.order`. Only applied to fields known to carry `ui` —
 * every versioned field has it (the versioned ⟺ ui invariant, enforced by a
 * registry test), so the cast is safe and there's no unreachable fallback.
 */
const byUiOrder = (a: AgentFieldDescriptor, b: AgentFieldDescriptor): number =>
  (a.ui as AgentFieldUi).order - (b.ui as AgentFieldUi).order;

/** Versioned fields, in display order. Drives `VERSIONED_FIELDS` and the snapshot
 *  whitelist — the same list, by design. */
export function versionedFieldNames(): string[] {
  return AGENT_FIELDS.filter((f) => f.versioned)
    .slice()
    .sort(byUiOrder)
    .map((f) => f.name);
}

/**
 * Versioned scalar columns only (excludes the grant relations), in display
 * order. The PATCH change-detection loop runs over the `data` update object,
 * which carries scalars; grant changes are detected separately from their join
 * rows. Use this for "did a versioned column change", {@link snapshotFieldNames}
 * for "what to capture in the snapshot".
 */
export function versionedScalarFieldNames(): string[] {
  return AGENT_FIELDS.filter((f) => f.versioned && f.kind === 'scalar')
    .slice()
    .sort(byUiOrder)
    .map((f) => f.name);
}

/**
 * The snapshot whitelist — the subset of a live `AiAgent` row captured into a
 * version snapshot. Identical to {@link versionedFieldNames}: a field is
 * snapshotted iff it is versioned.
 */
export function snapshotFieldNames(): string[] {
  return versionedFieldNames();
}

/** `field → label` for the version-diff table (versioned fields only). */
export function fieldLabels(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of AGENT_FIELDS) {
    if (f.ui) out[f.name] = f.ui.label;
  }
  return out;
}

/** `field → form tab` for the change-summary headline (versioned fields only). */
export function fieldToTab(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of AGENT_FIELDS) {
    if (f.ui) out[f.name] = f.ui.tab;
  }
  return out;
}

/** Versioned fields in stable display order — drives the diff table sort. */
export function fieldOrder(): string[] {
  return AGENT_FIELDS.filter((f) => f.ui)
    .slice()
    .sort(byUiOrder)
    .map((f) => f.name);
}

/**
 * Scalar fields the PATCH route assigns plainly from the request body
 * (`data[field] = body[field]` when present). Excludes the relation/history
 * special-write fields and create-only / elsewhere-managed fields, which the
 * route handles explicitly.
 */
export function patchAssignableScalarFields(): string[] {
  return AGENT_FIELDS.filter((f) => f.kind === 'scalar' && !f.write && !f.patchOmit).map(
    (f) => f.name
  );
}

/**
 * Scalar fields copied verbatim from the source agent when cloning — every
 * scalar except the ones the clone route sets explicitly (`name`/`slug` get
 * fresh values, `isActive` resets to false). Each entry flags whether it's a
 * JSON column so the caller can coerce null → `Prisma.JsonNull`.
 */
export function cloneCopiedScalarFields(): { name: string; json: boolean }[] {
  const explicit = new Set(['name', 'slug', 'isActive']);
  return AGENT_FIELDS.filter((f) => f.kind === 'scalar' && !explicit.has(f.name)).map((f) => ({
    name: f.name,
    json: f.json === true,
  }));
}

/** Look up a single descriptor by field name. */
export function getAgentField(name: string): AgentFieldDescriptor | undefined {
  return AGENT_FIELDS.find((f) => f.name === name);
}
