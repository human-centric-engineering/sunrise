/**
 * Model parameters an agent or an `llm_call` step stores beyond
 * temperature / max tokens / reasoning effort, turned into `LlmOptions`.
 *
 * Kept apart from `model-heuristics` (which decides what each model accepts)
 * so a test that mocks that module whole still gets these.
 */

import { z } from 'zod';

import {
  MAX_STOP_SEQUENCES,
  SERVICE_TIERS,
  VERBOSITIES,
  type LlmOptions,
  type ProviderTools,
  type ServiceTier,
  type Verbosity,
} from '@/lib/orchestration/llm/types';

/** Most searches an agent may allow in one response. */
export const MAX_WEB_SEARCH_USES = 20;

/** Most domains in a web search allow or block list. */
export const MAX_WEB_SEARCH_DOMAINS = 50;

/**
 * A domain as Anthropic's web search takes it: a host, optionally with a
 * path (`example.com`, `docs.example.com/api`), no scheme.
 */
const webSearchDomainSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/\S*)?$/i,
    'Enter a domain like example.com, without http://'
  );

const webSearchDomainsSchema = z
  .array(webSearchDomainSchema)
  .max(MAX_WEB_SEARCH_DOMAINS, `At most ${MAX_WEB_SEARCH_DOMAINS} domains`)
  .optional();

/**
 * `AiAgent.providerTools` — the tools the provider runs itself
 * ({@link ProviderTools}). The validation schemas and the runtime read below
 * share it, so a stored value the API would refuse is never sent.
 */
export const providerToolsSchema = z
  .object({
    webSearch: z
      .object({
        maxUses: z
          .number()
          .int()
          .min(1, 'At least 1 search')
          .max(MAX_WEB_SEARCH_USES, `At most ${MAX_WEB_SEARCH_USES} searches`)
          .optional(),
        // An empty allow list would be sent as none, so search every site.
        allowedDomains: webSearchDomainsSchema.refine(
          (domains) => domains === undefined || domains.length > 0,
          'List at least one site, or choose Any site'
        ),
        blockedDomains: webSearchDomainsSchema,
      })
      .strict()
      // Anthropic takes one list or the other, never both (a 400).
      .refine((search) => !(search.allowedDomains?.length && search.blockedDomains?.length), {
        message: 'Use either allowed domains or blocked domains, not both',
        path: ['blockedDomains'],
      })
      .optional(),
    // No options yet: present means on.
    codeExecution: z.object({}).strict().optional(),
  })
  .strict();

/**
 * A tool loop's options for its next call, with the searches the reply has
 * already run taken off the search limit. The agent's `maxUses` caps one
 * reply, which can take several calls; each call runs at most what is left,
 * down to 0. The whole limit stays on `replyLimit`, for OpenAI, which caps
 * each call instead. Options with no limit, or no search yet, come back
 * unchanged.
 */
export function spendWebSearches<T extends { providerTools?: ProviderTools }>(
  options: T,
  used: number
): T {
  const search = options.providerTools?.webSearch;
  if (search?.maxUses === undefined || used <= 0) return options;
  return {
    ...options,
    providerTools: {
      ...options.providerTools,
      webSearch: {
        ...search,
        maxUses: Math.max(0, search.maxUses - used),
        replyLimit: search.replyLimit ?? search.maxUses,
      },
    },
  };
}

/**
 * `value` with one provider tool set, or with `null` turned off, and the
 * others left as they are. Null when that leaves none on, which is how an
 * agent stores "no provider tools".
 */
export function withProviderTool<K extends keyof ProviderTools>(
  value: ProviderTools | null,
  key: K,
  next: ProviderTools[K] | null
): ProviderTools | null {
  const others: ProviderTools = { ...value };
  delete others[key];
  if (next !== null && next !== undefined) return { ...others, [key]: next };
  return Object.keys(others).length > 0 ? others : null;
}

/**
 * Narrow a stored `providerTools` value (a JSON column, or a fork's bundle)
 * to {@link ProviderTools}, or `undefined` when it turns nothing on or does
 * not parse.
 */
export function narrowProviderTools(raw: unknown): ProviderTools | undefined {
  const parsed = providerToolsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { webSearch, codeExecution } = parsed.data;
  if (webSearch === undefined && codeExecution === undefined) return undefined;
  return {
    ...(webSearch !== undefined ? { webSearch } : {}),
    ...(codeExecution !== undefined ? { codeExecution: {} } : {}),
  };
}

/**
 * Narrow a stored value (plain `TEXT` column, or a bundle from a fork) to a
 * {@link Verbosity}, or `undefined`. Same reason as `narrowReasoningEffort`.
 */
export function narrowVerbosity(raw: string | null | undefined): Verbosity | undefined {
  return VERBOSITIES.find((value) => value === raw);
}

/** Narrow a stored value to a {@link ServiceTier}, or `undefined`. */
export function narrowServiceTier(raw: string | null | undefined): ServiceTier | undefined {
  return SERVICE_TIERS.find((value) => value === raw);
}

/** The stored model parameters `modelParamOptions` reads. */
export interface StoredModelParams {
  stopSequences?: readonly string[] | null;
  topP?: number | null;
  verbosity?: string | null;
  parallelToolCalls?: boolean | null;
  serviceTier?: string | null;
  /** A JSON column on an agent; an `llm_call` step has none. */
  providerTools?: unknown;
}

/**
 * The `LlmOptions` an agent row or an `llm_call` step config asks for,
 * narrowed (a stored value can come from raw SQL or a fork's bundle) and
 * with unset values left out, so the provider default applies. Whether a
 * model takes each one is the provider class's call, not this one's.
 */
export function modelParamOptions(
  stored: StoredModelParams
): Pick<
  LlmOptions,
  'stopSequences' | 'topP' | 'verbosity' | 'parallelToolCalls' | 'serviceTier' | 'providerTools'
> {
  const verbosity = narrowVerbosity(stored.verbosity);
  const serviceTier = narrowServiceTier(stored.serviceTier);
  const providerTools = narrowProviderTools(stored.providerTools);
  const stopSequences = (stored.stopSequences ?? [])
    // Blank or whitespace-only sequences are refused by Anthropic.
    .filter((stop) => stop.trim().length > 0)
    .slice(0, MAX_STOP_SEQUENCES);
  return {
    ...(stopSequences.length > 0 ? { stopSequences } : {}),
    ...(typeof stored.topP === 'number' ? { topP: stored.topP } : {}),
    ...(verbosity !== undefined ? { verbosity } : {}),
    ...(typeof stored.parallelToolCalls === 'boolean'
      ? { parallelToolCalls: stored.parallelToolCalls }
      : {}),
    ...(serviceTier !== undefined ? { serviceTier } : {}),
    ...(providerTools !== undefined ? { providerTools } : {}),
  };
}
