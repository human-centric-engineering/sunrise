/**
 * Generic event log (fork-readiness seam).
 *
 * A non-admin, app-facing event log. Sunrise's `logAdminAction` records admin
 * *configuration* changes; an app built on Sunrise often needs to record its
 * own domain events (a questionnaire submitted, an export requested, a webhook
 * received) without pretending they are admin actions.
 *
 * The underlying `AiAdminAuditLog` table is already shaped generically —
 * nullable `userId`, free-form `action` / `entityType` strings, and a
 * `metadata` JSON column — so this reuses it rather than adding a table.
 * **Schema-free by design:** no new model, no migration. The cost is a
 * semantic smell (an "admin" audit table holding non-admin rows); the benefit
 * is zero schema surface for apps to carry.
 *
 * Writes are fire-and-forget and pass through the same secret-redaction as
 * `logAdminAction` (it is the implementation). Distinguish app events from
 * admin actions by querying on your own `action` / `entityType` namespace.
 *
 * @see lib/orchestration/audit/admin-audit-logger.ts — the shared writer + redaction
 * @see .context/orchestration/analytics.md — querying the event/audit table
 */

import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

/** A single app/domain event to record. */
export interface AppEventEntry {
  /**
   * Free-form event name. Namespace it to your app so it is greppable and
   * never collides with Sunrise's `entity.verb` admin actions — e.g.
   * `"questionnaire.submitted"`, `"export.requested"`.
   */
  action: string;
  /** Free-form subject type, e.g. `"questionnaire"`, `"export"`. */
  entityType: string;
  /** The user the event pertains to, or `null` for system events. */
  userId?: string | null;
  entityId?: string | null;
  entityName?: string | null;
  /** Arbitrary structured context. Secret-named keys are redacted before write. */
  metadata?: Record<string, unknown> | null;
  clientIp?: string | null;
}

/**
 * Record an app/domain event. Fire-and-forget — never throws to the caller
 * (delegates to `logAdminAction`, which swallows and logs DB errors). Returns
 * synchronously; do not await.
 *
 * `changes` is intentionally omitted from the surface: app events record that
 * something happened, not a before/after config diff. Use `metadata` for
 * structured context.
 */
export function logEvent(entry: AppEventEntry): void {
  logAdminAction({
    userId: entry.userId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    entityName: entry.entityName ?? null,
    metadata: entry.metadata ?? null,
    clientIp: entry.clientIp ?? null,
  });
}
