/**
 * Reusable opt-in guard rule fragments for the provenance contract.
 *
 * Workflow authors paste {@link provenanceRequiredRule}() into their
 * `guard` step's `rules` prompt to enforce attribution on selected
 * top-level array fields of the producer step's output. The guard step's
 * existing LLM-mode validation rejects un-attributed proposals on
 * failure and uses its configured retry budget.
 *
 * Keeping this a string-fragment helper instead of a new step type:
 *
 *   - The engine surface stays unchanged.
 *   - The audit workflow already authors its guard rules as one long
 *     prompt — same shape, additive rule.
 *   - Downstream forks adopt provenance by changing a seed file, not the
 *     engine.
 *
 * Companion runtime helper: {@link extractProvenance} in `./types.ts`
 * (engine-level capture).
 */

/** Options for {@link provenanceRequiredRule}. All fields optional. */
export interface ProvenanceRuleOptions {
  /**
   * Top-level array fields of the producer's JSON output that the rule
   * applies to. Each entry in those arrays must carry a non-empty
   * `sources` array. Defaults to `['changes', 'newModels', 'deactivateModels']`
   * to match the provider-model-audit shape; pass an explicit list for
   * other workflows (e.g. `['proposals', 'claims']`).
   */
  fields?: readonly string[];
  /**
   * When true (default), nested array entries beneath each field must
   * also carry `sources`. Set false for flat shapes where the entry
   * itself carries provenance, not nested rows.
   */
  perItem?: boolean;
  /**
   * When set, becomes the Rule's number heading. Lets authors slot the
   * rule into an existing numbered list cleanly. Defaults to `8` because
   * that's how the audit workflow's guard organises its rules; the rule
   * body still reads correctly with a different number.
   */
  ruleNumber?: number;
}

const DEFAULT_FIELDS = ['changes', 'newModels', 'deactivateModels'] as const;

/**
 * Returns a single string fragment to inline into a `guard` step's
 * `rules` prompt. The fragment:
 *
 *   - declares the field list scanned,
 *   - spells out the {@link ProvenanceItem} shape contract (literals,
 *     required `reference` for non-training sources, no
 *     `training_knowledge` at `high` confidence),
 *   - includes a worked rejection example so the LLM's pattern-match for
 *     "what does a failure look like" anchors to the same shape the
 *     producer is being asked to emit.
 *
 * Intentionally verbose: LLM guards in `mode: 'llm'` are sensitive to
 * how concretely the contract is stated. The audit workflow's existing
 * guard already inlines its enum spec for the same reason.
 */
export function provenanceRequiredRule(options: ProvenanceRuleOptions = {}): string {
  const fields = options.fields ?? DEFAULT_FIELDS;
  const perItem = options.perItem ?? true;
  const ruleNumber = options.ruleNumber ?? 8;

  const fieldList = fields.map((f) => `\`${f}\``).join(', ');
  const scanTarget = perItem
    ? `Every entry in each of these arrays MUST have a non-empty \`sources\` array.`
    : `Each of these arrays MUST itself have a non-empty \`sources\` array.`;

  return `${ruleNumber}. **Provenance.** This proposal applies to the top-level arrays: ${fieldList}. ${scanTarget} Each \`sources[i]\` must:
   - Have a \`source\` field equal to one of: \`training_knowledge\`, \`web_search\`, \`knowledge_base\`, \`prior_step\`, \`external_call\`, \`user_input\`.
   - Have a \`confidence\` field equal to one of: \`high\`, \`medium\`, \`low\`.
   - When \`source\` is \`web_search\`, \`knowledge_base\`, \`external_call\`, or \`prior_step\`: have a non-empty \`reference\` string (URL, chunk id, or step path).
   - When \`source\` is \`training_knowledge\`: \`confidence\` MUST be \`medium\` or \`low\` (never \`high\`).
   - \`snippet\` and \`note\` are optional; if present they must be non-empty strings.
   Reject the proposal if its sources array is missing, empty, or any entry fails the above. Quote the offending object so the producer can attribute on retry.

   Worked rejection: \`{ "field": "tierRole", "proposedValue": "embedding" }\` (no sources) → FAIL. Producer must emit at least one source per item.`;
}
