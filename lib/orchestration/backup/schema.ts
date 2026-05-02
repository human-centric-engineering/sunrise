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
  knowledgeCategories: z.array(z.string()),
  topicBoundaries: z.array(z.string()),
  brandVoiceInstructions: z.string().nullable(),
  rateLimitRpm: z.number().nullable().optional().default(null),
  inputGuardMode: z.string().nullable().optional().default(null),
  outputGuardMode: z.string().nullable().optional().default(null),
  citationGuardMode: z.string().nullable().optional().default(null),
  maxHistoryTokens: z.number().nullable().optional().default(null),
  retentionDays: z.number().nullable().optional().default(null),
  providerConfig: z.unknown().nullable().optional().default(null),
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

export const backupSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  data: z.object({
    agents: z.array(agentBackupSchema),
    capabilities: z.array(capabilityBackupSchema),
    workflows: z.array(workflowBackupSchema),
    webhooks: z.array(webhookBackupSchema),
    settings: settingsBackupSchema.nullable(),
  }),
});

export type BackupPayload = z.infer<typeof backupSchema>;
