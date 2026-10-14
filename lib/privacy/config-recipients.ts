/**
 * Configuration that names a person as a recipient or an approver, for erasure
 * (Art. 17) (t-791).
 *
 * Three places in other admins' configuration name a person, and none has a
 * foreign key the erasure cascade could follow:
 *
 *   • the escalation email list on the orchestration settings row
 *     (`escalationConfig.emailAddresses`), which every escalation emails;
 *   • a workflow `send_notification` step's `to`, a literal address or a list
 *     of them;
 *   • a `human_approval` step's `approverUserIds`.
 *
 * A step lives in a workflow's draft and in every published version's
 * snapshot. **All of them are rewritten** (owner ruling 2026-10-14): the
 * version executions run would otherwise keep emailing the person, a rollback
 * would bring the address back, and old snapshots would keep their personal
 * data. That makes erasure the one writer allowed to change a published
 * version, which `.context/orchestration/workflow-versioning.md` records.
 *
 * **When the list empties** (same ruling) it stays empty and fails loudly
 * rather than being dropped or guessed at: a notification step whose only
 * recipient was the person has no recipients, so the step fails until an
 * admin adds one, and the builder will not save or publish it without one; an
 * escalation list keeps its webhook and priority with no addresses, so
 * nothing is emailed, and the settings form asks for an address on its next
 * save. An approval step with no named approvers is valid as it is: the run's
 * owner and admins can still answer it.
 *
 * **Matching.** An address is matched on the rule the rest of erasure uses:
 * exact on `normaliseAddress()`, compared in code, and only for a verified
 * address — an unverified one may be a stranger's inbox, so `address` is null
 * and no address is touched. A template recipient (`{{input.email}}`) is never
 * an address and is left alone. Approvers are matched on the user id, which
 * names exactly one account whether or not its address was verified.
 *
 * Every change is audit-logged, naming what changed and never the address,
 * because the log outlives the erasure.
 *
 * @see lib/privacy/erase-user.ts — calls {@link eraseFromConfigRecipients}
 */

import type { Prisma } from '@prisma/client';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';

/** Written on the audit row as the reason for every change made here. */
const ERASURE_REASON = 'A person this configuration named was erased.';

export interface ConfigRecipientsSubject {
  /** The person being erased. */
  userId: string;
  /** Their normalised address, or null when it was never verified. */
  address: string | null;
  /** Who asked for the erasure: the audit rows are written as them. */
  actorUserId: string;
}

export interface ConfigRecipientsResult {
  /** Settings rows whose escalation list named the person. */
  escalationListsChanged: number;
  /** Workflows with a draft or a version that named the person. */
  workflowsChanged: number;
}

type ConfigClient = Pick<
  Prisma.TransactionClient,
  'aiOrchestrationSettings' | 'aiWorkflow' | 'aiWorkflowVersion' | 'aiAdminAuditLog'
>;

/** What {@link removeFromDefinition} took out of one definition. */
export interface DefinitionChange {
  definition: Prisma.JsonObject;
  /** Notification steps that lost the address. */
  notificationStepIds: string[];
  /** Approval steps that lost the approver. */
  approvalStepIds: string[];
  /** Notification steps left with no recipient at all. */
  emptiedStepIds: string[];
}

function matchesAddress(value: Prisma.JsonValue | undefined, address: string): boolean {
  return typeof value === 'string' && normaliseAddress(value) === address;
}

function isJsonObject(value: Prisma.JsonValue | undefined): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The definition without the person, or null when it does not name them. Pure,
 * and tolerant of a definition that does not parse: a step it cannot read is
 * left as it is, never dropped.
 */
export function removeFromDefinition(
  definition: Prisma.JsonValue,
  subject: Pick<ConfigRecipientsSubject, 'userId' | 'address'>
): DefinitionChange | null {
  if (!isJsonObject(definition) || !Array.isArray(definition.steps)) return null;
  const { userId, address } = subject;
  const notificationStepIds: string[] = [];
  const approvalStepIds: string[] = [];
  const emptiedStepIds: string[] = [];

  const steps = definition.steps.map((step): Prisma.JsonValue => {
    if (!isJsonObject(step) || !isJsonObject(step.config)) return step;
    const { config } = step;
    const stepId = typeof step.id === 'string' ? step.id : '';

    if (step.type === 'send_notification' && config.channel === 'email' && address !== null) {
      const { to } = config;
      if (matchesAddress(to, address)) {
        notificationStepIds.push(stepId);
        emptiedStepIds.push(stepId);
        // The builder's own empty value for a single recipient.
        return { ...step, config: { ...config, to: '' } };
      }
      if (Array.isArray(to) && to.some((entry) => matchesAddress(entry, address))) {
        const kept = to.filter((entry) => !matchesAddress(entry, address));
        notificationStepIds.push(stepId);
        if (kept.length === 0) emptiedStepIds.push(stepId);
        return { ...step, config: { ...config, to: kept } };
      }
    }

    if (
      step.type === 'human_approval' &&
      Array.isArray(config.approverUserIds) &&
      config.approverUserIds.includes(userId)
    ) {
      const approvers = config.approverUserIds;
      approvalStepIds.push(stepId);
      return {
        ...step,
        config: {
          ...config,
          approverUserIds: approvers.filter((id) => id !== userId),
        },
      };
    }

    return step;
  });

  if (notificationStepIds.length === 0 && approvalStepIds.length === 0) return null;
  return {
    definition: { ...definition, steps },
    notificationStepIds,
    approvalStepIds,
    emptiedStepIds,
  };
}

/**
 * Remove the person from the escalation list, and from every workflow draft
 * and version that names them, inside the erasure transaction.
 */
export async function eraseFromConfigRecipients(
  tx: ConfigClient,
  subject: ConfigRecipientsSubject
): Promise<ConfigRecipientsResult> {
  const escalationListsChanged = subject.address
    ? await eraseFromEscalationLists(tx, subject.address, subject.actorUserId)
    : 0;
  const workflowsChanged = await eraseFromWorkflows(tx, subject);
  return { escalationListsChanged, workflowsChanged };
}

async function eraseFromEscalationLists(
  tx: ConfigClient,
  address: string,
  actorUserId: string
): Promise<number> {
  // The settings row is a singleton (`slug: 'global'`), read whole: there is
  // no index to serve and nothing to gain from one.
  const rows = await tx.aiOrchestrationSettings.findMany({
    select: { id: true, slug: true, escalationConfig: true },
  });
  let changed = 0;
  for (const row of rows) {
    const config = row.escalationConfig;
    if (!isJsonObject(config) || !Array.isArray(config.emailAddresses)) continue;
    const before = config.emailAddresses;
    const kept = before.filter((entry) => !matchesAddress(entry, address));
    if (kept.length === before.length) continue;
    // Webhook and priority stay: only the person goes, even when they were the
    // only recipient (owner ruling 2026-10-14).
    await tx.aiOrchestrationSettings.update({
      where: { id: row.id },
      data: { escalationConfig: { ...config, emailAddresses: kept } },
    });
    await tx.aiAdminAuditLog.create({
      data: {
        userId: actorUserId,
        action: 'settings.escalation_recipient_erased',
        entityType: 'settings',
        entityId: row.slug,
        entityName: 'Escalation routing',
        changes: { escalationRecipientCount: { from: before.length, to: kept.length } },
        metadata: { reason: ERASURE_REASON },
      },
    });
    changed += 1;
  }
  return changed;
}

async function eraseFromWorkflows(
  tx: ConfigClient,
  subject: ConfigRecipientsSubject
): Promise<number> {
  // JSON containment narrows the rows read to workflows that could name the
  // person: an approval step listing their id (exact, so this is the match),
  // or any email notification step (whose `to` is stored as typed, so the
  // address is compared in code, after normalising, by `removeFromDefinition`).
  const containing: Prisma.InputJsonValue[] = [
    { type: 'human_approval', config: { approverUserIds: [subject.userId] } },
  ];
  if (subject.address) containing.push({ type: 'send_notification', config: { channel: 'email' } });
  const draftFilters = containing.map((step) => ({
    draftDefinition: { path: ['steps'], array_contains: [step] },
  }));
  const snapshotFilters = containing.map((step) => ({
    snapshot: { path: ['steps'], array_contains: [step] },
  }));

  const workflows = await tx.aiWorkflow.findMany({
    where: { OR: [...draftFilters, { versions: { some: { OR: snapshotFilters } } }] },
    select: {
      id: true,
      name: true,
      orgId: true,
      draftDefinition: true,
      versions: {
        where: { OR: snapshotFilters },
        select: { id: true, version: true, snapshot: true },
        orderBy: { version: 'asc' },
      },
    },
  });

  let changed = 0;
  for (const workflow of workflows) {
    const notificationStepIds = new Set<string>();
    const approvalStepIds = new Set<string>();
    const emptiedStepIds = new Set<string>();
    const record = (change: DefinitionChange) => {
      change.notificationStepIds.forEach((id) => notificationStepIds.add(id));
      change.approvalStepIds.forEach((id) => approvalStepIds.add(id));
      change.emptiedStepIds.forEach((id) => emptiedStepIds.add(id));
    };

    const draft = removeFromDefinition(workflow.draftDefinition, subject);
    if (draft) {
      await tx.aiWorkflow.update({
        where: { id: workflow.id },
        data: { draftDefinition: draft.definition },
      });
      record(draft);
    }

    const versions: number[] = [];
    for (const version of workflow.versions) {
      const change = removeFromDefinition(version.snapshot, subject);
      if (!change) continue;
      await tx.aiWorkflowVersion.update({
        where: { id: version.id },
        data: { snapshot: change.definition },
      });
      record(change);
      versions.push(version.version);
    }

    // An email step that never named this person matched the narrowing above
    // but changes nothing: no write, no audit row.
    if (!draft && versions.length === 0) continue;
    await tx.aiAdminAuditLog.create({
      data: {
        userId: subject.actorUserId,
        action: 'workflow.recipient_erased',
        entityType: 'workflow',
        entityId: workflow.id,
        entityName: workflow.name,
        metadata: {
          reason: ERASURE_REASON,
          orgId: workflow.orgId,
          draft: draft !== null,
          versions,
          notificationStepIds: [...notificationStepIds],
          approvalStepIds: [...approvalStepIds],
          stepsLeftWithoutRecipients: [...emptiedStepIds],
        },
      },
    });
    changed += 1;
  }
  return changed;
}
