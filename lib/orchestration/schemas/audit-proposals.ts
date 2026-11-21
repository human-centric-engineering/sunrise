/**
 * `audit-proposals` — Zod schema for the structural shape produced by
 * the three audit-workflow producers (`analyse_chat`,
 * `analyse_embedding`, `discover_new_models`).
 *
 * The schema is consumed by the `validate_proposals` guard step in
 * `prisma/seeds/data/templates/provider-model-audit.ts` (mode:
 * 'schema', inputStepIds: ['analyse_chat', 'analyse_embedding',
 * 'discover_new_models']).
 *
 * Replaces the prior LLM-mode validator's structural rules (Rules
 * 1–9 of the previous prompt). The remaining subjective rule — Rule
 * 10, "the change reason must engage with currentValue" — stays on
 * a downstream LLM-mode `validate_rationale` guard. LLM judgement
 * is the right tool for "is this sentence on-topic for this field";
 * LLM judgement is the wrong tool for "is `vision` in this six-
 * element array."
 *
 * Every enum is imported from `lib/orchestration/model-audit/enums`
 * so the schema cannot drift from the apply-side validation
 * (`apply-audit-changes` capability uses the same constants). The
 * AUDITABLE_FIELDS list comes from the capability itself for the
 * same reason — one source of truth per closed set.
 *
 * Module side effect: `registerSchema('audit-proposals', ...)` runs
 * at module load. The schemas barrel
 * (`lib/orchestration/schemas/index.ts`) imports this file so the
 * registration fires once per Node process whenever the engine
 * loads the guard executor.
 */

import { z } from 'zod';

import { registerSchema } from '@/lib/orchestration/schemas/registry';
import {
  isHalfPrice,
  MAX_PRICE_PER_MILLION_TOKENS,
  missingPriceField,
  PRICE_FIELDS,
  splitPriceInputSchema,
  touchesPricesAsPair,
} from '@/lib/validations/model-pricing';
import {
  CAPABILITIES,
  CONFIDENCE,
  CONTEXT_LENGTH,
  COST_EFFICIENCY,
  DEPLOYMENT_PROFILES,
  LATENCY,
  QUALITY,
  REASONING_DEPTH,
  TIER_ROLES,
  TOOL_USE,
} from '@/lib/orchestration/model-audit/enums';
import {
  AUDITABLE_FIELDS,
  sameAuditValue,
} from '@/lib/orchestration/capabilities/built-in/apply-audit-changes';

// ─── Helpers ───────────────────────────────────────────────────────────────

// Cast away the `readonly` on `as const` tuples so Zod's `z.enum`
// accepts them. The tuple type carries the literal union, which is
// what `z.enum` infers — no type erosion.
const asEnum = <T extends readonly [string, ...string[]]>(arr: T): [...T] => [...arr];

const SOURCE_KIND = [
  'web_search',
  'training_knowledge',
  'knowledge_base',
  'prior_step',
  'external_call',
  'user_input',
] as const;

const KINDS_REQUIRING_REFERENCE = new Set([
  'web_search',
  'knowledge_base',
  'external_call',
  'prior_step',
]);

/**
 * Sources that can back a price (t-774): ones that point at something an
 * admin can open and check. A price goes straight into recorded costs and
 * budget caps, so a model's own recollection (`training_knowledge`), an
 * unreferenced user claim, or the registry's existing value (`prior_step`,
 * which can't support a *change*) is not enough on its own.
 */
const PRICE_SOURCE_KINDS = new Set(['web_search', 'knowledge_base', 'external_call']);

function hasPriceSource(sources: ReadonlyArray<{ source: string; reference?: string }>): boolean {
  return sources.some(
    (s) => PRICE_SOURCE_KINDS.has(s.source) && typeof s.reference === 'string' && s.reference !== ''
  );
}

/**
 * Whether a proposed price is one the apply side will accept: a number in
 * range, or a decimal string the model wrote for one (`"3"`). The same
 * reading `apply_audit_changes` uses, so a proposal that passes here is not
 * refused there, and the reverse.
 */
function isValidPrice(value: unknown): boolean {
  return splitPriceInputSchema.safeParse(value).success;
}

// ─── Sub-schemas ───────────────────────────────────────────────────────────

const sourceAttributionSchema = z
  .object({
    source: z.enum(asEnum(SOURCE_KIND)),
    confidence: z.enum(asEnum(CONFIDENCE)),
    reference: z.string().optional(),
    snippet: z.string().optional(),
    note: z.string().optional(),
    stepId: z.string().optional(),
  })
  .superRefine((s, ctx) => {
    // Rule 9c: `web_search` / `knowledge_base` / `external_call` /
    // `prior_step` sources need a non-empty reference (URL, chunk
    // id, or step path). The LLM mode validator used to enforce
    // this in prose; here it's a one-line refine.
    if (KINDS_REQUIRING_REFERENCE.has(s.source)) {
      if (typeof s.reference !== 'string' || s.reference.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: `${s.source} source requires a non-empty \`reference\``,
          path: ['reference'],
        });
      }
    }
    // Rule 9d: training_knowledge sources cap confidence at medium.
    // High confidence on a training-only source is the audit's #1
    // confabulation signal — the model claims certainty about
    // something it pulled out of its weights.
    if (s.source === 'training_knowledge' && s.confidence === 'high') {
      ctx.addIssue({
        code: 'custom',
        message: '`training_knowledge` sources must be confidence `medium` or `low` — never `high`',
        path: ['confidence'],
      });
    }
  });

// Per-field enum lookup so the change's `proposedValue` can be
// validated against the right closed set. Mirrors `ENUM_BY_AUDIT_FIELD`
// in `lib/orchestration/model-audit/enums.ts` — the same constant the
// admin UI's per-field Select widget uses.
const PER_FIELD_ENUMS: Record<string, readonly string[]> = {
  tierRole: TIER_ROLES,
  reasoningDepth: REASONING_DEPTH,
  latency: LATENCY,
  costEfficiency: COST_EFFICIENCY,
  contextLength: CONTEXT_LENGTH,
  toolUse: TOOL_USE,
  quality: QUALITY,
  confidence: CONFIDENCE,
};

const ARRAY_FIELD_ENUMS: Record<string, readonly string[]> = {
  capabilities: CAPABILITIES,
  deploymentProfiles: DEPLOYMENT_PROFILES,
};

const changeSchema = z
  .object({
    field: z.enum(asEnum(AUDITABLE_FIELDS)),
    currentValue: z.unknown(),
    proposedValue: z.unknown(),
    reason: z.string().min(1),
    confidence: z.enum(asEnum(CONFIDENCE)),
    sources: z.array(sourceAttributionSchema).min(1, 'sources must be non-empty'),
  })
  .superRefine((change, ctx) => {
    // Per-field enum check: the proposedValue must be in the
    // corresponding enum when the field is one of the enum-typed
    // fields. Hits Rule 2 of the old LLM validator.
    const allowed = PER_FIELD_ENUMS[change.field];
    if (allowed) {
      if (typeof change.proposedValue !== 'string') {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": proposedValue must be a string`,
          path: ['proposedValue'],
        });
      } else if (!allowed.includes(change.proposedValue)) {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": proposedValue "${change.proposedValue}" is not in [${allowed.join(', ')}]`,
          path: ['proposedValue'],
        });
      }
    }
    // Per-element membership for array fields. Hits Rule 3 (the
    // `capabilities` array — the specific failure that motivated
    // this rewrite) and Rule 4 (deploymentProfiles).
    const arrayAllowed = ARRAY_FIELD_ENUMS[change.field];
    if (arrayAllowed) {
      if (!Array.isArray(change.proposedValue)) {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": proposedValue must be an array`,
          path: ['proposedValue'],
        });
      } else {
        // `proposedValue` is `unknown` at the schema level; narrow
        // to `unknown[]` after the Array.isArray() guard above.
        const proposed = change.proposedValue as unknown[];
        for (let i = 0; i < proposed.length; i++) {
          const el = proposed[i];
          if (typeof el !== 'string' || !arrayAllowed.includes(el)) {
            ctx.addIssue({
              code: 'custom',
              message: `field "${change.field}": element "${String(el)}" is not in [${arrayAllowed.join(', ')}]`,
              path: ['proposedValue', i],
            });
          }
        }
        if (change.field === 'deploymentProfiles' && proposed.length === 0) {
          // Rule 4 also forbids empty deploymentProfiles arrays —
          // every model has at least one deployment locus.
          ctx.addIssue({
            code: 'custom',
            message: 'deploymentProfiles cannot be an empty array',
            path: ['proposedValue'],
          });
        }
      }
    }
    // Prices (t-774): a number in range, backed by a checkable source.
    if (PRICE_FIELDS.has(change.field)) {
      if (!isValidPrice(change.proposedValue)) {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": proposedValue must be a number from 0 to ${MAX_PRICE_PER_MILLION_TOKENS} (USD per 1M tokens)`,
          path: ['proposedValue'],
        });
      }
      if (!hasPriceSource(change.sources)) {
        ctx.addIssue({
          code: 'custom',
          message: `field "${change.field}": a price needs a web_search, knowledge_base or external_call source with a reference — training knowledge alone is not enough`,
          path: ['sources'],
        });
      }
    }
    // A change to nothing (t-1076). A price, enum or array field's own checks
    // above refuse an empty value; `description`, `bestRole`, `dimensions`
    // and `schemaCompatible` have none, and an accepted empty value would
    // wipe the row's.
    if (isEmptyValue(change.proposedValue) && !hasTypedValue(change.field)) {
      ctx.addIssue({
        code: 'custom',
        message: `field "${change.field}": proposedValue is empty — a change needs a new value, so leave this change out`,
        path: ['proposedValue'],
      });
    }
  });

/** `null`, missing, or a blank string. */
function isEmptyValue(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

const modelProposalSchema = z
  .object({
    model_id: z.string().min(1),
    modelName: z.string().min(1),
    providerSlug: z.string().min(1),
    changes: z.array(changeSchema),
    overallConfidence: z.enum(asEnum(CONFIDENCE)),
    reasoning: z.string(),
  })
  .superRefine((proposal, ctx) => {
    // The two prices are proposed together, once each (t-774).
    if (!touchesPricesAsPair(proposal.changes.map((c) => c.field))) {
      ctx.addIssue({
        code: 'custom',
        message:
          'propose inputCostPerMillionTokens and outputCostPerMillionTokens together, once each, or neither',
        path: ['changes'],
      });
    }
    // A change that changes nothing (t-1076). On a small default model the
    // embedding analyser proposed `tierRole: embedding → embedding` for every
    // embedding model, which reached the approval queue as rows to accept.
    // Compared as the apply step compares (`3` is `"3"` for a price, arrays
    // are sets), so nothing this passes is a no-op there. The one allowed
    // case is a price restated unchanged because its partner moves: prices
    // go in pairs.
    const unchanged = (c: { field: string; currentValue: unknown; proposedValue: unknown }) =>
      sameAuditValue(c.field, c.currentValue, c.proposedValue);
    const partnerMoves = proposal.changes.some((c) => PRICE_FIELDS.has(c.field) && !unchanged(c));
    proposal.changes.forEach((change, i) => {
      if (!unchanged(change)) return;
      if (PRICE_FIELDS.has(change.field) && partnerMoves) return;
      // An empty value is already refused by the change's own checks; a
      // second issue for it only adds noise to the retry. (Zod skips this
      // model-level refinement when a change fails a non-continuable check,
      // such as a field not in the enum, so a no-op beside one surfaces on
      // the next attempt instead.)
      if (isEmptyValue(change.proposedValue)) return;
      ctx.addIssue({
        code: 'custom',
        message: `field "${change.field}": proposedValue is the same as currentValue, so nothing changes — leave this change out`,
        path: ['changes', i, 'proposedValue'],
      });
    });
  });

/** A field whose change-level checks already refuse an empty proposed value. */
function hasTypedValue(field: string): boolean {
  return PRICE_FIELDS.has(field) || field in PER_FIELD_ENUMS || field in ARRAY_FIELD_ENUMS;
}

/** An optional string where `""` means none, the same as `null`. */
const emptyAsNull = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
  z.string().nullish()
);

const deactivationSchema = z.object({
  modelId: z.string().min(1),
  reason: z.string().min(1),
  sources: z.array(sourceAttributionSchema).min(1),
  // Vendor retirement (§136 t-1064): the announced day, and the vendor's
  // model id of the same-provider successor. `null` or `""` = none found.
  // Neither is refined here: one stray field must not fail the whole
  // analysis branch, and every other proposal with it. The capability
  // judges each entry: a day that is not YYYY-MM-DD makes that entry
  // `invalid`, and a successor without a day is left out with a note.
  retiresAt: emptyAsNull,
  replacedBy: emptyAsNull,
});

const analysisBranchSchema = z.object({
  models: z.array(modelProposalSchema),
  deactivateModels: z.array(deactivationSchema),
});

const newModelSchema = z
  .object({
    name: z.string().min(1),
    // Rule 6: slug must match the slug regex (lowercase, hyphenated).
    slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    providerSlug: z.string().min(1),
    // modelId must use the provider's canonical short form: lowercase
    // alphanumeric runs joined by `.` / `-` / `/`, with no leading or
    // trailing separator. Catches the common drift modes — uppercase
    // (`Claude-Opus-4`), spaces, dated suffixes leaving a trailing
    // hyphen, etc. The "no date suffix" rule itself is semantic and
    // belongs in the prompt; this regex is the structural floor.
    modelId: z.string().regex(/^[a-z0-9]+([./-][a-z0-9]+)*$/),
    description: z.string().min(1),
    // Per-element enum check (Rule 3): each capability is in the
    // CAPABILITIES spec.
    capabilities: z.array(z.enum(asEnum(CAPABILITIES))),
    tierRole: z.enum(asEnum(TIER_ROLES)),
    // Rule 4: each profile in DEPLOYMENT_PROFILES; non-empty.
    deploymentProfiles: z.array(z.enum(asEnum(DEPLOYMENT_PROFILES))).min(1),
    reasoningDepth: z.enum(asEnum(REASONING_DEPTH)).optional(),
    latency: z.enum(asEnum(LATENCY)).optional(),
    costEfficiency: z.enum(asEnum(COST_EFFICIENCY)).optional(),
    contextLength: z.enum(asEnum(CONTEXT_LENGTH)).optional(),
    toolUse: z.enum(asEnum(TOOL_USE)).optional(),
    bestRole: z.string().min(1),
    sources: z.array(sourceAttributionSchema).min(1),
    // Embedding-only enrichment fields. Optional so the chat / agent
    // new-model proposals don't have to carry them.
    dimensions: z.number().int().positive().optional(),
    quality: z.enum(asEnum(QUALITY)).optional(),
    schemaCompatible: z.boolean().optional(),
    // Chat pricing (t-774): optional, as a pair, backed by a checkable source.
    // `null` is the model saying it found no price — the same as leaving it out.
    // A decimal string is accepted as the number it spells; range is checked below.
    inputCostPerMillionTokens: z.union([z.number(), z.string()]).nullish(),
    outputCostPerMillionTokens: z.union([z.number(), z.string()]).nullish(),
  })
  .superRefine((model, ctx) => {
    const hasInput = model.inputCostPerMillionTokens != null;
    if (!hasInput && model.outputCostPerMillionTokens == null) return;
    if (isHalfPrice(model.inputCostPerMillionTokens, model.outputCostPerMillionTokens)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'propose inputCostPerMillionTokens and outputCostPerMillionTokens together, or neither',
        path: [missingPriceField(model.inputCostPerMillionTokens)],
      });
    }
    for (const field of ['inputCostPerMillionTokens', 'outputCostPerMillionTokens'] as const) {
      const value = model[field];
      if (value != null && !isValidPrice(value)) {
        ctx.addIssue({
          code: 'custom',
          message: `${field} must be a number from 0 to ${MAX_PRICE_PER_MILLION_TOKENS} (USD per 1M tokens)`,
          path: [field],
        });
      }
    }
    if (!hasPriceSource(model.sources)) {
      ctx.addIssue({
        code: 'custom',
        message:
          'a proposed price needs a web_search, knowledge_base or external_call source with a reference — training knowledge alone is not enough',
        path: ['sources'],
      });
    }
  });

const discoveryBranchSchema = z.object({
  newModels: z.array(newModelSchema),
  reasoning: z.string(),
});

// ─── Registration ──────────────────────────────────────────────────────────

/**
 * The URLs the web search step returned, or `null` when its output was not
 * passed to this schema at all.
 *
 * The step is an `external_call`, whose output is `{ status, body }` (plus
 * `_transformError` when the transform failed); `body` is the Brave
 * transform's array of `{ title, url, description }`. A skipped step's
 * output is `null`: no search ran, so there are no URLs. A missing key is a
 * guard saved before t-1076 (an admin's clone of the template), which still
 * lists only the three producers: it gets the old behaviour, unchecked,
 * rather than failing every run.
 */
function searchResultUrls(input: unknown): Set<string> | null {
  if (typeof input !== 'object' || input === null || !('search_provider_info' in input)) {
    return null;
  }
  const output: unknown = input.search_provider_info;
  const body: unknown =
    typeof output === 'object' && output !== null && 'body' in output ? output.body : output;
  const urls = new Set<string>();
  if (Array.isArray(body)) {
    const results: unknown[] = body;
    for (const result of results) {
      if (typeof result === 'object' && result !== null && 'url' in result) {
        if (typeof result.url === 'string') urls.add(normaliseUrl(result.url));
      }
    }
  }
  return urls;
}

/**
 * A URL as compared: no protocol, lower-case host without `www.`, no query,
 * fragment or trailing slash. A model copying a result's URL drops or adds
 * exactly these; the page is the same page.
 */
function normaliseUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    return `${host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

type SourceAt = { source: { source: string; reference?: string }; path: (string | number)[] };

/** Every source in the three producers' output, with its path. */
function* allSources(value: {
  analyse_chat: z.infer<typeof analysisBranchSchema>;
  analyse_embedding: z.infer<typeof analysisBranchSchema>;
  discover_new_models: z.infer<typeof discoveryBranchSchema>;
}): Generator<SourceAt> {
  for (const branch of ['analyse_chat', 'analyse_embedding'] as const) {
    for (const [i, model] of value[branch].models.entries()) {
      for (const [j, change] of model.changes.entries()) {
        for (const [k, source] of change.sources.entries()) {
          yield { source, path: [branch, 'models', i, 'changes', j, 'sources', k, 'reference'] };
        }
      }
    }
    for (const [i, deactivation] of value[branch].deactivateModels.entries()) {
      for (const [k, source] of deactivation.sources.entries()) {
        yield { source, path: [branch, 'deactivateModels', i, 'sources', k, 'reference'] };
      }
    }
  }
  for (const [i, model] of value.discover_new_models.newModels.entries()) {
    for (const [k, source] of model.sources.entries()) {
      yield { source, path: ['discover_new_models', 'newModels', i, 'sources', k, 'reference'] };
    }
  }
}

// Compound schema — keys match the audit template's `inputStepIds:
// ['search_provider_info', 'analyse_chat', 'analyse_embedding',
// 'discover_new_models']`. The executor builds `{ [stepId]: output }` and
// feeds it to this schema; mismatched keys produce a clear issue path.
//
// A `web_search` source must be one of the search step's results (t-1076).
// On a dev run with no Brave key, the search was skipped and gpt-4o-mini
// still cited `web_search` "https://openai.com/pricing" with an invented
// snippet for a GPT-5 price of $3/$12 (it is $1.25/$10). A URL alone passed
// the price rule; an admin accepting it would mis-cost every GPT-5 call.
export const auditProposalsSchema = z
  .object({
    // Read by `searchResultUrls` below; any shape is accepted here.
    search_provider_info: z.unknown().optional(),
    analyse_chat: analysisBranchSchema,
    analyse_embedding: analysisBranchSchema,
    discover_new_models: discoveryBranchSchema,
  })
  .superRefine((value, ctx) => {
    const urls = searchResultUrls(value);
    if (urls === null) return;
    for (const { source, path } of allSources(value)) {
      if (source.source !== 'web_search' || typeof source.reference !== 'string') continue;
      if (urls.has(normaliseUrl(source.reference))) continue;
      ctx.addIssue({
        code: 'custom',
        message:
          urls.size === 0
            ? "a web_search source must be one of this audit's web search results, and the search returned none — cite another kind of source, or leave the claim out"
            : `web_search source "${source.reference}" is not one of this audit's web search results — cite one of them by its exact URL, or leave the claim out`,
        path,
      });
    }
  });

registerSchema('audit-proposals', auditProposalsSchema);
