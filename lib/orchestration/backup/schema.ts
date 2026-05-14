/**
 * Backup/Restore Schema
 *
 * Zod schema for validating orchestration backup payloads.
 * Versioned so future changes can be detected and handled.
 */

import { z } from 'zod';

const agentBackupSchema = z.object({
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  systemInstructions: z.string(),
  model: z.string(),
  provider: z.string(),
  fallbackProviders: z.array(z.string()),
  temperature: z.number(),
  maxTokens: z.number(),
  monthlyBudgetUsd: z.number().nullable(),
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
  url: z.string(),
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
