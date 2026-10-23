/**
 * The versions of the configuration erasure scrubs, for refusing a stale save
 * (§122 t-899, `lib/api/record-version.ts`).
 *
 * Each version is a hash of the fields a save of that record can write: what
 * the form loaded, and what it would write back. A field nothing saves (a
 * schedule's `nextRunAt`, which the tick moves on every firing; a
 * subscription's `secret`, never returned) is left out, so it cannot refuse a
 * save it has nothing to do with.
 *
 *   • **A webhook subscription**: every field its PATCH writes but the secret.
 *     Erasure clears the address and switches it off, which changes both.
 *   • **A schedule**: every field its PATCH writes. Erasure blanks an address
 *     in its `inputTemplate`.
 *   • **The escalation list**: `escalationConfig` alone. The settings row is
 *     shared by five forms and only one writes this field, so a save of the
 *     default models is not refused because erasure took someone off the list.
 *
 * Each lock is `FOR NO KEY UPDATE`, the lock erasure takes on the same rows
 * (`config-recipients.ts`, `erase-user.ts`, `run-recipients.ts`).
 */

import type { Prisma } from '@prisma/client';
import { recordVersion } from '@/lib/api/record-version';

type LockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** The subscription fields its version covers. Select them wherever it is computed. */
export const SUBSCRIPTION_VERSION_SELECT = {
  channel: true,
  url: true,
  emailAddress: true,
  events: true,
  agentIds: true,
  workflowIds: true,
  isActive: true,
  description: true,
  maxAttempts: true,
  retryBackoffMs: true,
} as const;

type SubscriptionVersioned = Prisma.AiWebhookSubscriptionGetPayload<{
  select: typeof SUBSCRIPTION_VERSION_SELECT;
}>;

export function subscriptionVersion(row: SubscriptionVersioned): string {
  return recordVersion([
    'webhook-subscription',
    row.channel,
    row.url,
    row.emailAddress,
    row.events,
    row.agentIds,
    row.workflowIds,
    row.isActive,
    row.description,
    row.maxAttempts,
    row.retryBackoffMs,
  ]);
}

/** The schedule fields its version covers. */
export const SCHEDULE_VERSION_SELECT = {
  name: true,
  cronExpression: true,
  inputTemplate: true,
  isEnabled: true,
  scope: true,
} as const;

type ScheduleVersioned = Prisma.AiWorkflowScheduleGetPayload<{
  select: typeof SCHEDULE_VERSION_SELECT;
}>;

export function scheduleVersion(row: ScheduleVersioned): string {
  return recordVersion([
    'workflow-schedule',
    row.name,
    row.cronExpression,
    row.inputTemplate,
    row.isEnabled,
    row.scope,
  ]);
}

/** The escalation list's version: `escalationConfig` as stored, `null` when unset. */
export function escalationVersion(escalationConfig: unknown): string {
  return recordVersion(['escalation-config', escalationConfig ?? null]);
}

/** Lock a subscription for a versioned save. A missing row takes nothing. */
export async function lockSubscriptionRow(tx: LockClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM ai_webhook_subscription WHERE id = ${id} FOR NO KEY UPDATE`;
}

/** Lock a schedule for a versioned save. */
export async function lockScheduleRow(tx: LockClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM ai_workflow_schedule WHERE id = ${id} FOR NO KEY UPDATE`;
}

/** Lock the settings row for a versioned save of the escalation list. */
export async function lockSettingsRow(tx: LockClient, slug: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM ai_orchestration_settings WHERE slug = ${slug} FOR NO KEY UPDATE`;
}
