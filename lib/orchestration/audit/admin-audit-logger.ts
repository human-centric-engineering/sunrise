/**
 * Admin Audit Logger
 *
 * Fire-and-forget writes to the AiAdminAuditLog table. Tracks admin
 * configuration changes across agents, workflows, capabilities, knowledge,
 * settings, and webhooks.
 *
 * Follows the same pattern as `lib/orchestration/mcp/audit-logger.ts`.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AdminAuditEntry {
  userId: string | null;
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
 * Matches field names that are likely secrets. `key`/`token` must END the field
 * name (optionally `s`-pluralised, or suffixed with `Hash`/`Hashes`) so that
 * credential digests like `keyHash` / `tokenHash` are redacted while non-secret
 * fields such as `apiKeyCount` or `tokenizeInput` are not. Longer words
 * (`password`, `secret`, `credential`) match anywhere — so `passwordHash` /
 * `secretHash` are already covered. `hash` is deliberately NOT matched on its
 * own: fields like `fileHash` / `contentHash` / `subjectEmailHash` are non-secret
 * dedup/correlation digests that should stay visible in an audit diff (issue
 * #388 — the credential digest that motivated this is `keyHash`).
 */
// The end anchor is kept INSIDE the `(?:…$)` group so it clearly binds only to
// the `key`/`token` branch (password/secret/credential match anywhere) — a bare
// top-level `$` reads as anchoring the whole alternation (CodeQL
// js/regex/missing-regexp-anchor).
const SECRET_PATTERN = /password|secret|credential|(?:key|token)(?:(?:s|hash(?:es)?)?$)/i;

function sanitizeChanges(
  changes: Record<string, { from: unknown; to: unknown }> | null | undefined
): Record<string, { from: unknown; to: unknown }> | null {
  if (!changes) return null;

  const sanitized: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, diff] of Object.entries(changes)) {
    if (SECRET_PATTERN.test(field)) {
      sanitized[field] = { from: '[REDACTED]', to: '[REDACTED]' };
    } else {
      sanitized[field] = {
        from: sanitizeMetadataValue(diff.from),
        to: sanitizeMetadataValue(diff.to),
      };
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
 *
 * `options.ignoreKeys` skips the listed keys entirely — useful when one or
 * both sides include columns that always differ (e.g. Prisma's `@updatedAt`
 * bumps on every `update()` call so it would otherwise mark every PATCH as
 * a change) or asymmetric relation arrays (e.g. one side fetched with
 * `include`, the other without).
 */
export function computeChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options?: { ignoreKeys?: Iterable<string> }
): Record<string, { from: unknown; to: unknown }> | null {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const ignore = options?.ignoreKeys ? new Set(options.ignoreKeys) : null;

  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (ignore?.has(key)) continue;
    try {
      const a = JSON.stringify(before[key]);
      const b = JSON.stringify(after[key]);
      if (a !== b) {
        changes[key] = { from: before[key], to: after[key] };
      }
    } catch {
      // Non-serializable value (circular ref, BigInt, etc.) — record as changed
      changes[key] = { from: '[unserializable]', to: '[unserializable]' };
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
        changes: (() => {
          const s = sanitizeChanges(entry.changes);
          return s === null ? Prisma.JsonNull : (s as Prisma.InputJsonValue);
        })(),
        metadata: (() => {
          const s = sanitizeMetadata(entry.metadata);
          return s === null ? Prisma.JsonNull : (s as Prisma.InputJsonValue);
        })(),
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

// ─── Conversation access helper ─────────────────────────────────────────────

/**
 * Convenience wrapper for logging conversation accesses with the
 * consistent metadata shape that downstream queries depend on:
 *
 *   metadata.accessBasis           — 'owner' | 'shared'
 *   metadata.conversationOwnerId   — the end user who owns the row
 *
 * Together with `userId` (the calling admin) these two keys answer the
 * compliance-team question "which other users' conversations did admin
 * X view this month?" via a single query — `WHERE action LIKE
 * 'conversation.%' AND metadata->>'accessBasis' = 'shared'`.
 *
 * **Owner accesses skip logging by convention.** This helper writes a
 * row only when `basis === 'shared'` — routine self-access would flood
 * the audit log without adding signal. The function silently no-ops on
 * `basis === 'owner'` so callers don't need a branch.
 *
 * The `extra` metadata object is merged into the persisted JSON
 * alongside the access-basis keys; callers use it to carry route-
 * specific context (e.g. `{ format: 'json', messageCount }` for the
 * provenance routes).
 */
export function logConversationAccess(params: {
  adminUserId: string;
  conversationId: string;
  conversationTitle: string | null;
  conversationOwnerId: string | null;
  /** `'owner'` accesses are intentionally not logged — see fn docstring. */
  accessBasis: 'owner' | 'shared';
  /** Route-level action name, e.g. `'conversation.messages_viewed'`. */
  action: string;
  /** Optional additional metadata — merged into the persisted JSON. */
  extra?: Record<string, unknown>;
  clientIp?: string | null;
}): void {
  if (params.accessBasis === 'owner') return;
  logAdminAction({
    userId: params.adminUserId,
    action: params.action,
    entityType: 'conversation',
    entityId: params.conversationId,
    entityName: params.conversationTitle,
    metadata: {
      accessBasis: params.accessBasis,
      conversationOwnerId: params.conversationOwnerId,
      ...params.extra,
    },
    clientIp: params.clientIp ?? null,
  });
}
