/**
 * Admin Audit Logger
 *
 * Fire-and-forget writes to the AiAdminAuditLog table. Tracks admin
 * configuration changes across agents, workflows, capabilities, knowledge,
 * settings, and webhooks.
 *
 * Follows the same pattern as `lib/orchestration/mcp/audit-logger.ts`.
 */

import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AdminAuditEntry {
  userId: string;
  action: string; // e.g. "agent.create", "workflow.update", "settings.update"
  entityType: string; // "agent", "workflow", "capability", "knowledge_document", "settings", "webhook"
  entityId?: string | null;
  entityName?: string | null;
  changes?: Record<string, { from: unknown; to: unknown }> | null;
  metadata?: Record<string, unknown> | null;
  clientIp?: string | null;
}

// ─── Secret sanitisation ────────────────────────────────────────────────────

/**
 * Matches field names that are likely secrets. For common words (`key`,
 * `token`) requires them to END the field name (or the whole name) to
 * avoid over-redacting fields like `apiKeyCount` or `tokenizeInput`.
 * Longer words (`password`, `secret`, `credential`) are matched anywhere.
 */
const SECRET_PATTERN = /password|secret|credential|(?:key|token)(?:s?$)/i;

function sanitizeChanges(
  changes: Record<string, { from: unknown; to: unknown }> | null | undefined
): Record<string, { from: unknown; to: unknown }> | null {
  if (!changes) return null;

  const sanitized: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, diff] of Object.entries(changes)) {
    if (SECRET_PATTERN.test(field)) {
      sanitized[field] = { from: '[REDACTED]', to: '[REDACTED]' };
    } else {
      sanitized[field] = diff;
    }
  }
  return sanitized;
}

function sanitizeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeMetadataValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_PATTERN.test(key) ? '[REDACTED]' : sanitizeMetadataValue(v);
    }
    return out;
  }
  return value;
}

function sanitizeMetadata(
  metadata: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!metadata) return null;
  return sanitizeMetadataValue(metadata) as Record<string, unknown>;
}

// ─── Diff utility ───────────────────────────────────────────────────────────

/**
 * Compute a shallow diff of changed fields between two objects.
 * Only includes fields that actually changed. Returns null if no changes.
 */
export function computeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, { from: unknown; to: unknown }> | null {
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    const a = JSON.stringify(before[key]);
    const b = JSON.stringify(after[key]);
    if (a !== b) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

// ─── Logger ─────────────────────────────────────────────────────────────────

/**
 * Log an admin action. Fire-and-forget — never throws to the caller.
 */
export function logAdminAction(entry: AdminAuditEntry): void {
  void prisma.aiAdminAuditLog
    .create({
      data: {
        userId: entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        entityName: entry.entityName ?? null,
        changes: sanitizeChanges(entry.changes) as never,
        metadata: sanitizeMetadata(entry.metadata) as never,
        clientIp: entry.clientIp ?? null,
      },
    })
    .catch((err: unknown) => {
      logger.error('Failed to write admin audit log', {
        error: err instanceof Error ? err.message : String(err),
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
      });
    });
}
