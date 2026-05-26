/**
 * Shared settings hydration for the orchestration settings singleton.
 *
 * Extracted from the settings API route so both the API route and server
 * components (e.g. costs page) can produce the same `OrchestrationSettings`
 * shape without a self-referential HTTP call.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { computeDefaultModelMap } from '@/lib/orchestration/llm/model-registry';
import {
  searchConfigSchema,
  storedDefaultModelsSchema,
  escalationConfigSchema,
} from '@/lib/validations/orchestration';
import {
  TASK_TYPES,
  type ApprovalDefaultAction,
  type EscalationConfig,
  type InputGuardMode,
  type OutputGuardMode,
  type OrchestrationSettings,
  type SearchConfig,
  type TaskType,
} from '@/types/orchestration';

/**
 * Narrow a `Prisma.JsonValue` loaded from `AiOrchestrationSettings.defaultModels`
 * into a `Record<string, string>` via Zod. Anything that isn't a plain object of
 * string values collapses to `{}` so callers can safely spread / lookup keys.
 */
export function parseStoredDefaults(
  raw: Prisma.JsonValue | null | undefined
): Record<string, string> {
  const parsed = storedDefaultModelsSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * Narrow a `Prisma.JsonValue` loaded from `AiOrchestrationSettings.searchConfig`
 * into a typed `SearchConfig` via Zod. Returns `null` if the stored value is
 * absent or invalid — callers should fall back to built-in defaults.
 */
export function parseSearchConfig(raw: Prisma.JsonValue | null | undefined): SearchConfig | null {
  const parsed = searchConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Narrow a `Prisma.JsonValue` loaded from `AiOrchestrationSettings.escalationConfig`
 * into a typed `EscalationConfig` via Zod. Returns `null` if absent or invalid.
 */
export function parseEscalationConfig(
  raw: Prisma.JsonValue | null | undefined
): EscalationConfig | null {
  const parsed = escalationConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Hydrate a raw Prisma row into the `OrchestrationSettings` response shape,
 * filling in any task keys the stored JSON is missing from the registry defaults.
 */
const VALID_APPROVAL_ACTIONS = new Set<ApprovalDefaultAction>(['deny', 'allow']);
const VALID_GUARD_MODES = new Set<InputGuardMode>(['log_only', 'warn_and_continue', 'block']);
const VALID_OUTPUT_GUARD_MODES = new Set<OutputGuardMode>([
  'log_only',
  'warn_and_continue',
  'block',
]);

export function hydrateSettings(row: {
  id: string;
  slug: string;
  defaultModels: Prisma.JsonValue;
  globalMonthlyBudgetUsd: number | null;
  searchConfig: Prisma.JsonValue | null;
  lastSeededAt: Date | null;
  defaultApprovalTimeoutMs: number | null;
  approvalDefaultAction: string | null;
  inputGuardMode: string | null;
  outputGuardMode: string | null;
  citationGuardMode: string | null;
  webhookRetentionDays: number | null;
  costLogRetentionDays: number | null;
  auditLogRetentionDays: number | null;
  executionRetentionDays: number | null;
  evaluationRetentionDays: number | null;
  maxConversationsPerUser: number | null;
  maxMessagesPerConversation: number | null;
  escalationConfig?: Prisma.JsonValue | null;
  embedAllowedOrigins?: Prisma.JsonValue | null;
  voiceInputGloballyEnabled?: boolean | null;
  imageInputGloballyEnabled?: boolean | null;
  documentInputGloballyEnabled?: boolean | null;
  activeEmbeddingModelId?: string | null;
  stuckExecutionThresholdMins?: number | null;
  defaultMaxCostPerExecutionUsd?: number | null;
  defaultMaxCostPerTurnUsd?: number | null;
  createdAt: Date;
  updatedAt: Date;
}): OrchestrationSettings {
  const computed = computeDefaultModelMap();
  const stored = parseStoredDefaults(row.defaultModels);
  const merged: Record<TaskType, string> = { ...computed };
  // Operator-saved subset, preserved separately so UIs can show
  // "you saved this" vs "this is the system suggestion".
  const storedOnly: Partial<Record<TaskType, string>> = {};
  for (const key of TASK_TYPES) {
    const val = stored[key];
    if (typeof val === 'string' && val.length > 0) {
      merged[key] = val;
      storedOnly[key] = val;
    }
  }

  function isApprovalAction(v: string): v is ApprovalDefaultAction {
    return VALID_APPROVAL_ACTIONS.has(v as ApprovalDefaultAction);
  }
  function isInputGuard(v: string): v is InputGuardMode {
    return VALID_GUARD_MODES.has(v as InputGuardMode);
  }
  function isOutputGuard(v: string): v is OutputGuardMode {
    return VALID_OUTPUT_GUARD_MODES.has(v as OutputGuardMode);
  }

  return {
    id: row.id,
    slug: 'global',
    defaultModels: merged,
    defaultModelsStored: storedOnly,
    globalMonthlyBudgetUsd: row.globalMonthlyBudgetUsd,
    searchConfig: parseSearchConfig(row.searchConfig),
    lastSeededAt: row.lastSeededAt,
    defaultApprovalTimeoutMs: row.defaultApprovalTimeoutMs,
    approvalDefaultAction:
      row.approvalDefaultAction && isApprovalAction(row.approvalDefaultAction)
        ? row.approvalDefaultAction
        : null,
    inputGuardMode:
      row.inputGuardMode === null
        ? null
        : isInputGuard(row.inputGuardMode)
          ? row.inputGuardMode
          : null,
    outputGuardMode:
      row.outputGuardMode === null
        ? null
        : isOutputGuard(row.outputGuardMode)
          ? row.outputGuardMode
          : null,
    citationGuardMode:
      row.citationGuardMode === null
        ? null
        : isOutputGuard(row.citationGuardMode)
          ? row.citationGuardMode
          : null,
    webhookRetentionDays: row.webhookRetentionDays,
    costLogRetentionDays: row.costLogRetentionDays,
    auditLogRetentionDays: row.auditLogRetentionDays,
    executionRetentionDays: row.executionRetentionDays,
    evaluationRetentionDays: row.evaluationRetentionDays,
    maxConversationsPerUser: row.maxConversationsPerUser,
    maxMessagesPerConversation: row.maxMessagesPerConversation,
    escalationConfig: parseEscalationConfig(row.escalationConfig),
    embedAllowedOrigins: parseEmbedAllowedOrigins(row.embedAllowedOrigins),
    // The migration's column default is `true` — the optional / nullable
    // shape on the row type is defensive against pre-migration test
    // fixtures that omit the field entirely.
    voiceInputGloballyEnabled: row.voiceInputGloballyEnabled ?? true,
    imageInputGloballyEnabled: row.imageInputGloballyEnabled ?? true,
    documentInputGloballyEnabled: row.documentInputGloballyEnabled ?? true,
    activeEmbeddingModelId: row.activeEmbeddingModelId ?? null,
    stuckExecutionThresholdMins: clampStuckThreshold(row.stuckExecutionThresholdMins),
    defaultMaxCostPerExecutionUsd: row.defaultMaxCostPerExecutionUsd ?? null,
    defaultMaxCostPerTurnUsd: row.defaultMaxCostPerTurnUsd ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Min/max bounds for the "stuck step" threshold on the executions list
 * and live-engine dashboard. Floor of 1 minute stops a misconfigured
 * `0` from highlighting every row (which would make the signal
 * useless); ceiling of 1440 (24h) covers genuinely long-running batch
 * workflows while preventing a typo of e.g. `9999999` from disabling
 * the highlight entirely.
 */
const STUCK_THRESHOLD_MIN_MINS = 1;
const STUCK_THRESHOLD_MAX_MINS = 1440;
const STUCK_THRESHOLD_DEFAULT_MINS = 5;

/**
 * Defence-in-depth clamp on read. The PATCH validator clamps on write,
 * but a row written via seed / migration / direct SQL could land
 * outside the bounds. A bad value here would silently break the
 * executions-list "stuck" highlight, so we coerce rather than throw.
 */
export function clampStuckThreshold(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return STUCK_THRESHOLD_DEFAULT_MINS;
  const rounded = Math.round(value);
  if (rounded < STUCK_THRESHOLD_MIN_MINS) return STUCK_THRESHOLD_MIN_MINS;
  if (rounded > STUCK_THRESHOLD_MAX_MINS) return STUCK_THRESHOLD_MAX_MINS;
  return rounded;
}

export const STUCK_THRESHOLD_BOUNDS = {
  min: STUCK_THRESHOLD_MIN_MINS,
  max: STUCK_THRESHOLD_MAX_MINS,
  default: STUCK_THRESHOLD_DEFAULT_MINS,
} as const;

/**
 * Narrow the `embedAllowedOrigins` JSON column into a normalised
 * `string[]`. Defaults to an empty array if the row is missing the
 * field (e.g. on first read after the migration but before the row is
 * touched). Each entry is validated as an https / localhost URL and
 * normalised to its canonical `.origin` form (no path, no trailing
 * slash, default ports stripped) so it byte-matches what browsers
 * send in the `Origin` header.
 *
 * The settings PATCH schema also normalises on write (Zod
 * `.transform()`); this read-side parse is the safety net for rows
 * written before the schema landed, or via paths that bypass the
 * schema (direct DB write, future import/restore, etc.).
 *
 * Drops every entry that fails normalisation and logs `logger.warn` per
 * drop with a stable message string plus a context-specific structured
 * field set: `index` (entry position) and `value` (the offending string)
 * are emitted whenever they apply, augmented by `error` for URL parse
 * failures, `protocol`/`hostname` for unsupported-origin drops, and
 * `type` for non-string entries (or for the whole-field drop when the
 * column isn't an array). Silent dropping would otherwise make
 * corrupted DB rows invisible to operators — an admin who imports a
 * malformed allowlist would just see all approval POSTs return 403 with
 * no signal in logs. Logging keeps the safety-net behaviour (we never
 * fail the request) while making misconfiguration visible.
 */
function parseEmbedAllowedOrigins(raw: Prisma.JsonValue | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logger.warn('embedAllowedOrigins is not an array — ignoring entire field', {
      type: typeof raw,
    });
    return [];
  }
  return raw.flatMap((v, index): string[] => {
    if (typeof v !== 'string') {
      logger.warn('embedAllowedOrigins entry is not a string — dropping', {
        index,
        type: typeof v,
      });
      return [];
    }
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch (err) {
      logger.warn('embedAllowedOrigins entry is not a valid URL — dropping', {
        index,
        value: v,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
    const allowed =
      parsed.protocol === 'https:' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1';
    if (!allowed) {
      logger.warn('embedAllowedOrigins entry has unsupported protocol or host — dropping', {
        index,
        value: v,
        protocol: parsed.protocol,
        hostname: parsed.hostname,
      });
      return [];
    }
    return [parsed.origin];
  });
}

/**
 * Load the orchestration settings singleton, upserting if it doesn't exist yet.
 * Returns the hydrated `OrchestrationSettings` shape.
 */
export async function getOrchestrationSettings(): Promise<OrchestrationSettings> {
  const defaults = computeDefaultModelMap();
  const row = await prisma.aiOrchestrationSettings.upsert({
    where: { slug: 'global' },
    create: {
      slug: 'global',
      defaultModels: defaults,
      globalMonthlyBudgetUsd: null,
      searchConfig: Prisma.JsonNull,
      lastSeededAt: null,
      defaultApprovalTimeoutMs: null,
      approvalDefaultAction: 'deny',
      inputGuardMode: 'log_only',
      outputGuardMode: 'log_only',
      citationGuardMode: 'log_only',
    },
    update: {},
  });
  return hydrateSettings(row);
}
