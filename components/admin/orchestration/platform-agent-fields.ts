/**
 * How the admin UI names the fields an org tunes on a platform agent.
 *
 * The list itself always comes from the API (`platformAgent.tunableFields`
 * on `GET /agents/:id`, the rule the API enforces); this module only turns
 * it into prose, in the order an admin meets the fields on the form. Two
 * places use it: the agent form's banner, which says what this org can
 * change *here*, and the version-history restore dialog, which says what a
 * restore brings back.
 *
 * `providerConfig` has no control on the form (it is set through the API),
 * so the banner leaves it out; a restore does bring it back, so the dialog
 * names it. An org-tunable field a fork adds falls back to its registry
 * label.
 */

import { fieldLabels } from '@/lib/orchestration/agents/agent-field-registry';

const TUNABLE_FIELD_PHRASES: Record<string, string> = {
  provider: 'provider',
  model: 'model',
  fallbackProviders: 'fallback providers',
  providerConfig: 'provider configuration',
  monthlyBudgetUsd: 'monthly budget',
  maxCostPerTurnUsd: 'per-turn cost cap',
  rateLimitRpm: 'rate limit',
  retentionDays: 'how long its conversations are kept',
};

export interface DescribeTunableFieldsOptions {
  /** Name `providerConfig` if the list has it. Off for the banner. */
  includeProviderConfig?: boolean;
  /** Append "which capabilities it may use" (an agent whose bindings are the org's). */
  capabilitiesToo?: boolean;
}

/** "provider, model, … and how long its conversations are kept", from the API's list. */
export function describeTunableFields(
  fields: readonly string[],
  { includeProviderConfig = false, capabilitiesToo = false }: DescribeTunableFieldsOptions = {}
): string {
  const known = Object.keys(TUNABLE_FIELD_PHRASES).filter(
    (field) => fields.includes(field) && (includeProviderConfig || field !== 'providerConfig')
  );
  const forkFields = fields.filter((field) => !(field in TUNABLE_FIELD_PHRASES));
  const phrases = [
    ...known.map((field) => TUNABLE_FIELD_PHRASES[field]),
    ...forkFields.map((field) => (fieldLabels()[field] ?? field).toLowerCase()),
    ...(capabilitiesToo ? ['which capabilities it may use'] : []),
  ];
  if (phrases.length <= 1) return phrases.join('');
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;
}
