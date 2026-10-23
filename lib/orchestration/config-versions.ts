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
 *   • **A workflow's definition** (t-900): what the builder loaded, which is
 *     the draft, or the published snapshot when there is none, and which
 *     version is published. Erasure scrubs both the draft and the snapshots in
 *     place; a publish or rollback moves the published version. A workflow's
 *     name, toggles and cost cap are left out: nothing erasure scrubs.
 *
 * Each lock is `FOR NO KEY UPDATE`, the lock erasure takes on the same rows
 * (`config-recipients.ts`, `erase-user.ts`, `run-recipients.ts`).
 */

import type { Prisma } from '@prisma/client';
import { assertCurrentVersion, recordVersion } from '@/lib/api/record-version';

type LockClient = Pick<Prisma.TransactionClient, '$queryRaw'>;
type VersionClient = Pick<
  Prisma.TransactionClient,
  | '$queryRaw'
  | 'aiWebhookSubscription'
  | 'aiWorkflowSchedule'
  | 'aiOrchestrationSettings'
  | 'aiWorkflow'
>;

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

/** The workflow fields its definition version covers. */
export const WORKFLOW_DEFINITION_VERSION_SELECT = {
  draftDefinition: true,
  publishedVersionId: true,
  publishedVersion: { select: { snapshot: true } },
} as const;

type WorkflowDefinitionVersioned = Prisma.AiWorkflowGetPayload<{
  select: typeof WORKFLOW_DEFINITION_VERSION_SELECT;
}>;

export function workflowDefinitionVersion(row: WorkflowDefinitionVersioned): string {
  return recordVersion([
    'workflow-definition',
    row.draftDefinition ?? null,
    row.publishedVersionId,
    row.publishedVersion?.snapshot ?? null,
  ]);
}

/**
 * The version of a workflow's published snapshot alone, for a copy of it (a
 * custom template applied in the builder, save-as-template): a draft saved on
 * the source since does not change what was copied, so it does not refuse the
 * copy. Its own prefix, so it never equals a {@link workflowDefinitionVersion}.
 */
export function publishedSnapshotVersion(
  row: Pick<WorkflowDefinitionVersioned, 'publishedVersionId' | 'publishedVersion'>
): string {
  return recordVersion([
    'workflow-published',
    row.publishedVersionId,
    row.publishedVersion?.snapshot ?? null,
  ]);
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

/**
 * Lock a workflow for a versioned save of its definition. The published
 * snapshot is not locked with it: a writer that writes a definition takes the
 * erasure locks for everyone it names first (`version-service.ts`), which
 * orders it against an erasure scrubbing that snapshot.
 */
export async function lockWorkflowRow(tx: LockClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM ai_workflow WHERE id = ${id} FOR NO KEY UPDATE`;
}

/** A record a versioned save writes. */
export type VersionedRecord =
  | { kind: 'webhook-subscription'; id: string }
  | { kind: 'workflow-schedule'; id: string }
  | { kind: 'escalation-list' }
  | { kind: 'workflow-definition'; id: string };

/**
 * The record's version as stored now, read under its row lock: the lock is
 * held for the rest of `tx`. A missing subscription, schedule or workflow
 * throws.
 */
export async function lockedVersion(tx: VersionClient, record: VersionedRecord): Promise<string> {
  switch (record.kind) {
    case 'webhook-subscription': {
      await lockSubscriptionRow(tx, record.id);
      const row = await tx.aiWebhookSubscription.findUniqueOrThrow({
        where: { id: record.id },
        select: SUBSCRIPTION_VERSION_SELECT,
      });
      return subscriptionVersion(row);
    }
    case 'workflow-schedule': {
      await lockScheduleRow(tx, record.id);
      const row = await tx.aiWorkflowSchedule.findUniqueOrThrow({
        where: { id: record.id },
        select: SCHEDULE_VERSION_SELECT,
      });
      return scheduleVersion(row);
    }
    case 'escalation-list': {
      await lockSettingsRow(tx, 'global');
      const row = await tx.aiOrchestrationSettings.findUnique({
        where: { slug: 'global' },
        select: { escalationConfig: true },
      });
      return escalationVersion(row?.escalationConfig);
    }
    case 'workflow-definition': {
      await lockWorkflowRow(tx, record.id);
      const row = await tx.aiWorkflow.findUniqueOrThrow({
        where: { id: record.id },
        select: WORKFLOW_DEFINITION_VERSION_SELECT,
      });
      return workflowDefinitionVersion(row);
    }
  }
}

/**
 * A versioned save's check, inside the transaction that writes: lock the
 * record, and refuse with 412 unless it is still at a version the save was
 * loaded at (`If-Match`). Call before the write; the lock holds until `tx`
 * ends, so nothing (erasure included) can change the record in between.
 */
export async function assertUnchangedSince(
  tx: VersionClient,
  record: VersionedRecord,
  loadedAt: readonly string[]
): Promise<void> {
  assertCurrentVersion(loadedAt, await lockedVersion(tx, record));
}
