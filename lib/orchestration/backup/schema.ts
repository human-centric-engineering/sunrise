/**
 * Backup/Restore Schema
 *
 * Zod schema for validating orchestration backup payloads.
 * Versioned so future changes can be detected and handled.
 */

import { z } from 'zod';

export const agentBackupSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  systemInstructions: z.string(),
  model: z.string(),
  provider: z.string(),
  fallbackProviders: z.array(z.string()),
  temperature: z.number(),
  maxTokens: z.number(),
  // Reasoning-effort bucket. Added with the param-profile work; older
  // backup bundles omit the field, in which case the agent is imported
  // with `null` and the runtime sends no reasoning_effort. The enum
  // includes 'minimal' / 'low' / 'medium' / 'high'.
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).nullable().optional(),
  monthlyBudgetUsd: z.number().nullable(),
  // Per-turn cost cap added with improvement #39. Optional so older
  // backup bundles round-trip; null preserves "no cap" semantics on
  // re-import. The validator on read tolerates either omission or
  // explicit null.
  maxCostPerTurnUsd: z.number().nullable().optional(),
  visibility: z.string(),
  isActive: z.boolean(),
  metadata: z.unknown().nullable(),
  /**
   * `knowledgeCategories` was the legacy free-text scoping field on AiAgent.
   * Dropped in Phase 6 of knowledge-access-control. Older bundles (v1, pre-
   * Phase 1) still carry it on the wire — accepted here for backwards-compat
   * reading, ignored on the write side. The v1→v2 importer backfill that
   * synthesised tags from these strings still uses the value when present.
   */
  knowledgeCategories: z.array(z.string()).optional().default([]),
  /**
   * v2: knowledge access mode + cross-environment grant slugs. v1 backups omit
   * these — the importer treats missing values as `'full'` mode with empty
   * grants, preserving the legacy behaviour. The importer also runs the
   * v1→v2 backfill (look up tags by slug) when `knowledgeCategories` is
   * populated and the new fields are absent.
   */
  knowledgeAccessMode: z.enum(['full', 'restricted']).optional().default('full'),
  /**
   * Per-agent force-retrieval policy. Optional with defaults so older backups
   * (which omit these) import as the unchanged `'model'` / empty behaviour.
   */
  knowledgeRetrievalMode: z
    .enum(['model', 'first_turn', 'every_turn', 'keywords'])
    .optional()
    .default('model'),
  knowledgeTriggerKeywords: z.array(z.string()).optional().default([]),
  grantedTagSlugs: z.array(z.string()).optional().default([]),
  /**
   * Document grants are keyed by `AiKnowledgeDocument.fileHash` — content-derived
   * and stable across deployments. The importer looks up by hash; missing
   * documents are silently dropped (with a warning), preserving the rest of
   * the agent's grants.
   */
  grantedDocumentHashes: z.array(z.string()).optional().default([]),
  topicBoundaries: z.array(z.string()),
  brandVoiceInstructions: z.string().nullable(),
  // Discriminator + profile-inheritance + attachment + runtime-prompt fields.
  // All added after the initial backup schema; older bundles omit them, so each
  // is optional with the same default the agent create path applies — a v1/v2
  // bundle round-trips unchanged, a new bundle preserves the full config.
  kind: z.enum(['chat', 'judge']).optional().default('chat'),
  persona: z.string().nullable().optional().default(null),
  guardrails: z.string().nullable().optional().default(null),
  personaMode: z.enum(['override', 'append']).optional().default('override'),
  voiceMode: z.enum(['override', 'append']).optional().default('override'),
  guardrailsMode: z.enum(['override', 'append']).optional().default('override'),
  enableVoiceInput: z.boolean().optional().default(false),
  enableImageInput: z.boolean().optional().default(false),
  enableDocumentInput: z.boolean().optional().default(false),
  runtimePromptManaged: z.boolean().optional().default(false),
  runtimePromptNote: z.string().nullable().optional().default(null),
  rateLimitRpm: z.number().nullable().optional().default(null),
  inputGuardMode: z.string().nullable().optional().default(null),
  outputGuardMode: z.string().nullable().optional().default(null),
  citationGuardMode: z.string().nullable().optional().default(null),
  maxHistoryTokens: z.number().nullable().optional().default(null),
  maxHistoryMessages: z.number().nullable().optional().default(null),
  retentionDays: z.number().nullable().optional().default(null),
  providerConfig: z.unknown().nullable().optional().default(null),
  // widgetConfig (item 7). Opaque on the wire — resolveWidgetConfig
  // validates the shape on read. Older backups omit the field.
  widgetConfig: z.unknown().nullable().optional().default(null),
});

/**
 * v2 addition: top-level knowledge-tag taxonomy so import can recreate the
 * managed tags on an empty target. Keyed by slug (stable cross-environment).
 */
const knowledgeTagBackupSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable().optional().default(null),
});

const capabilityBackupSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  category: z.string(),
  functionDefinition: z.unknown(),
  executionType: z.string(),
  executionHandler: z.string(),
  executionConfig: z.unknown().nullable(),
  requiresApproval: z.boolean(),
  rateLimit: z.number().nullable(),
  isActive: z.boolean(),
});

const workflowBackupSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  workflowDefinition: z.unknown(),
  patternsUsed: z.array(z.number()),
  isActive: z.boolean(),
  isTemplate: z.boolean(),
  metadata: z.unknown().nullable(),
});

const webhookBackupSchema = z.object({
  // `channel` defaults to `webhook` so backups written before the
  // email-channel feature still round-trip cleanly.
  channel: z.enum(['webhook', 'email']).default('webhook'),
  url: z.string().nullable().optional(),
  emailAddress: z.string().nullable().optional(),
  events: z.array(z.string()),
  description: z.string().nullable().optional(),
  secret: z.string().optional(), // excluded on export, optional on import
  isActive: z.boolean(),
});

const settingsBackupSchema = z.object({
  defaultModels: z.unknown(),
  globalMonthlyBudgetUsd: z.number().nullable(),
  searchConfig: z.unknown().nullable(),
  defaultApprovalTimeoutMs: z.number().nullable(),
  approvalDefaultAction: z.string().nullable(),
  inputGuardMode: z.string().nullable(),
  outputGuardMode: z.string().nullable(),
  citationGuardMode: z.string().nullable().optional().default(null),
  webhookRetentionDays: z.number().nullable(),
  costLogRetentionDays: z.number().nullable(),
  auditLogRetentionDays: z.number().nullable().optional().default(null),
  executionRetentionDays: z.number().nullable().optional().default(null),
  evaluationRetentionDays: z.number().nullable().optional().default(null),
  maxConversationsPerUser: z.number().nullable(),
  maxMessagesPerConversation: z.number().nullable(),
  escalationConfig: z.unknown().nullable(),
});

// Schema version history:
//   v1 — original.
//   v2 — adds AiAgent.knowledgeAccessMode + grantedTagSlugs/grantedDocumentSlugs,
//        plus a top-level knowledgeTags array carrying the managed taxonomy.
//        v1 imports are accepted unchanged: the importer fills the new fields
//        with safe defaults (full access, no grants) and best-effort backfills
//        grants from the legacy knowledgeCategories array via slug lookup.
export const backupSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  exportedAt: z.string(),
  data: z.object({
    agents: z.array(agentBackupSchema),
    capabilities: z.array(capabilityBackupSchema),
    workflows: z.array(workflowBackupSchema),
    webhooks: z.array(webhookBackupSchema),
    knowledgeTags: z.array(knowledgeTagBackupSchema).optional().default([]),
    settings: settingsBackupSchema.nullable(),
  }),
});

export type BackupPayload = z.infer<typeof backupSchema>;
export type KnowledgeTagBackup = z.infer<typeof knowledgeTagBackupSchema>;
