/**
 * Shared settings hydration for the orchestration settings singleton.
 *
 * Extracted from the settings API route so both the API route and server
 * components (e.g. costs page) can produce the same `OrchestrationSettings`
 * shape without a self-referential HTTP call.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { computeDefaultModelMap } from '@/lib/orchestration/llm/model-registry';
import { searchConfigSchema, storedDefaultModelsSchema } from '@/lib/validations/orchestration';
import {
  TASK_TYPES,
  type ApprovalDefaultAction,
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
  webhookRetentionDays: number | null;
  costLogRetentionDays: number | null;
  maxConversationsPerUser: number | null;
  maxMessagesPerConversation: number | null;
  createdAt: Date;
  updatedAt: Date;
}): OrchestrationSettings {
  const computed = computeDefaultModelMap();
  const stored = parseStoredDefaults(row.defaultModels);
  const merged: Record<TaskType, string> = { ...computed };
  for (const key of TASK_TYPES) {
    const val = stored[key];
    if (typeof val === 'string' && val.length > 0) merged[key] = val;
  }

  const approvalAction = row.approvalDefaultAction as ApprovalDefaultAction | null;
  const guardMode = row.inputGuardMode as InputGuardMode | null;
  const outputMode = row.outputGuardMode as OutputGuardMode | null;

  return {
    id: row.id,
    slug: 'global',
    defaultModels: merged,
    globalMonthlyBudgetUsd: row.globalMonthlyBudgetUsd,
    searchConfig: parseSearchConfig(row.searchConfig),
    lastSeededAt: row.lastSeededAt,
    defaultApprovalTimeoutMs: row.defaultApprovalTimeoutMs,
    approvalDefaultAction:
      approvalAction && VALID_APPROVAL_ACTIONS.has(approvalAction) ? approvalAction : null,
    inputGuardMode: guardMode && VALID_GUARD_MODES.has(guardMode) ? guardMode : 'log_only',
    outputGuardMode:
      outputMode && VALID_OUTPUT_GUARD_MODES.has(outputMode) ? outputMode : 'log_only',
    webhookRetentionDays: row.webhookRetentionDays,
    costLogRetentionDays: row.costLogRetentionDays,
    maxConversationsPerUser: row.maxConversationsPerUser,
    maxMessagesPerConversation: row.maxMessagesPerConversation,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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
      defaultModels: defaults as unknown as Prisma.InputJsonValue,
      globalMonthlyBudgetUsd: null,
      searchConfig: Prisma.JsonNull,
      lastSeededAt: null,
      defaultApprovalTimeoutMs: null,
      approvalDefaultAction: 'deny',
      inputGuardMode: 'log_only',
      outputGuardMode: 'log_only',
    },
    update: {},
  });
  return hydrateSettings(row);
}
