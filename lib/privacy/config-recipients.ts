/**
 * Configuration that names a person as a recipient or an approver, for erasure
 * (Art. 17) (t-791).
 *
 * Four places in other admins' configuration name a person, and none has a
 * foreign key the erasure cascade could follow:
 *
 *   • the escalation email list on the orchestration settings row
 *     (`escalationConfig.emailAddresses`), which every escalation emails;
 *   • a workflow `send_notification` step's `to`, a literal address or a list
 *     of them;
 *   • a `human_approval` step's `approverUserIds`;
 *   • a `human_approval` step's `notificationChannel.target`, which can hold an
 *     address and is sent on in every `approval_required` event.
 *
 * A step lives in a workflow's draft and in every published version's
 * snapshot. **All of them are rewritten** (owner ruling 2026-10-14): the
 * version executions run would otherwise keep emailing the person, a rollback
 * would bring the address back, and old snapshots would keep their personal
 * data. That makes erasure the one writer allowed to change a published
 * version, which `.context/orchestration/workflow-versioning.md` records.
 *
 * **When the list empties** (same ruling) it stays empty rather than being
 * dropped or guessed at: a notification step whose only recipient was the
 * person has no recipients, so it fails when it runs — and its error strategy
 * decides what follows, so a step set to `skip` is skipped — and the builder
 * will not save, publish or run the workflow until an admin adds one; an
 * escalation list keeps its webhook and priority with no addresses, so nothing
 * is emailed, and the settings form asks for an address on its next save. An
 * approval step with no named approvers is valid as it is: the run's owner and
 * admins can still answer it.
 *
 * **Matching.** An address is matched on the rule the rest of erasure uses:
 * exact on `normaliseAddress()`, compared in code, and only for a verified
 * address — an unverified one may be a stranger's inbox, so `address` is null
 * and no address is touched. A template recipient (`{{input.email}}`) is never
 * an address and is left alone. Approvers are matched on the user id, which
 * names exactly one account whether or not its address was verified.
 *
 * **Reading.** Every row is read `FOR NO KEY UPDATE`: an admin's write to the
 * same row waits for the erasure rather than landing between its read and its
 * write, and is not overwritten by the copy read before it — while a new run's
 * insert, which takes `FOR KEY SHARE` on the workflow and version it points
 * at, is not blocked. A writer that read *before* the erasure and writes after
 * it (an open settings form, a builder tab, a publish in flight) is refused by
 * the writer itself: see `lib/privacy/erased-subjects.ts` (t-805). Workflows are narrowed in SQL by a plain
 * substring test on the definition's text — the user id, or the address with
 * ASCII letters (and U+212A KELVIN SIGN, the one non-ASCII character
 * `toLowerCase()` turns into ASCII) folded by `translate()`, never `lower()`,
 * whose result depends on the database's collation — so a row that cannot
 * name the person is never loaded; the exact match is then made in code. An
 * address that is not plain ASCII, or holds a character JSON escapes, cannot
 * be found that way, and every workflow with an email notification step or an
 * approval step's notification channel is read instead.
 *
 * Every change is audit-logged, naming what changed and never the address,
 * because the log outlives the erasure.
 *
 * @see lib/privacy/erase-user.ts — calls {@link eraseFromConfigRecipients}
 */

import type { Prisma } from '@prisma/client';
import { normaliseAddress } from '@/lib/orchestration/webhooks/destination';
import { isRecord } from '@/lib/utils';

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
  '$queryRaw' | 'aiOrchestrationSettings' | 'aiWorkflow' | 'aiWorkflowVersion' | 'aiAdminAuditLog'
>;

/**
 * Who to take out of a value: a user id, an address, or both. Either may be
 * null — an unverified account matches on its id alone, and an address found
 * in a bundle or a receipt has no id to go with it.
 */
export interface PersonMatch {
  userId: string | null;
  address: string | null;
}

/** What {@link removeFromDefinition} took out of one definition. */
export interface DefinitionChange {
  definition: Prisma.JsonObject;
  /** Notification steps that lost the address. */
  notificationStepIds: string[];
  /** Approval steps that lost the approver or the notification target. */
  approvalStepIds: string[];
  /** Notification steps left with no recipient at all. */
  emptiedStepIds: string[];
}

function matchesAddress(value: Prisma.JsonValue | undefined, address: string): boolean {
  return typeof value === 'string' && normaliseAddress(value) === address;
}

/**
 * A JSON object, typed as one. `isRecord` (`@/lib/utils`) answers the same
 * question for `unknown`, but narrows to `Record<string, unknown>`, and the
 * rewritten definition must stay JSON to be written back without a cast.
 */
export function isJsonObject(value: Prisma.JsonValue | undefined): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An approval step's config without the person, or null when it does not name them. */
function approvalWithout(
  config: Prisma.JsonObject,
  userId: string | null,
  address: string | null
): Prisma.JsonObject | null {
  let next = config;
  const approvers = config.approverUserIds;
  if (userId !== null && Array.isArray(approvers) && approvers.includes(userId)) {
    next = { ...next, approverUserIds: approvers.filter((id) => id !== userId) };
  }
  const channel = config.notificationChannel;
  if (address !== null && isJsonObject(channel) && matchesAddress(channel.target, address)) {
    // The channel and its type stay; only where it pointed goes.
    const { target: _erased, ...rest } = channel;
    next = { ...next, notificationChannel: rest };
  }
  return next === config ? null : next;
}

/**
 * The approver ids and notification target an approval step's config, or a
 * paused run's approval payload, names. Tolerant of either being malformed.
 */
export function approvalRecipients(config: Record<string, unknown>): {
  addresses: string[];
  userIds: string[];
} {
  const userIds: string[] = [];
  if (Array.isArray(config.approverUserIds)) {
    for (const id of config.approverUserIds) if (typeof id === 'string') userIds.push(id);
  }
  const channel = config.notificationChannel;
  const addresses = isRecord(channel) && typeof channel.target === 'string' ? [channel.target] : [];
  return { addresses, userIds };
}

/**
 * The definition without the person, or null when it does not name them. Pure,
 * and tolerant of a definition that does not parse: a step it cannot read is
 * left as it is, never dropped.
 */
export function removeFromDefinition(
  definition: Prisma.JsonValue,
  subject: PersonMatch
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

    if (step.type === 'human_approval') {
      const next = approvalWithout(config, userId, address);
      if (next) {
        approvalStepIds.push(stepId);
        return { ...step, config: next };
      }
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
 * Every address and approver id a definition names — the same places
 * {@link removeFromDefinition} reads, so a writer refusing an erased person
 * (t-805, `lib/privacy/erased-subjects.ts`) asks about exactly what erasure
 * would have removed. Tolerant of a definition that does not parse.
 */
export function definitionRecipients(definition: Prisma.JsonValue | undefined): {
  addresses: string[];
  userIds: string[];
} {
  const addresses: string[] = [];
  const userIds: string[] = [];
  if (!isJsonObject(definition) || !Array.isArray(definition.steps)) {
    return { addresses, userIds };
  }
  for (const step of definition.steps) {
    if (!isJsonObject(step) || !isJsonObject(step.config)) continue;
    const { config } = step;
    if (step.type === 'send_notification' && config.channel === 'email') {
      const { to } = config;
      if (typeof to === 'string') addresses.push(to);
      if (Array.isArray(to)) {
        for (const entry of to) if (typeof entry === 'string') addresses.push(entry);
      }
    }
    if (step.type === 'human_approval') {
      const named = approvalRecipients(config);
      addresses.push(...named.addresses);
      userIds.push(...named.userIds);
    }
  }
  return { addresses, userIds };
}

/**
 * The address as the SQL narrowing searches for it, or null when that search
 * could miss it: anything outside printable ASCII (folded by neither side the
 * same way), and `"` or `\`, which a definition's JSON text escapes.
 */
export function asciiSearchTerm(address: string): string | null {
  return /^[\x20-\x7e]+$/.test(address) && !/["\\]/.test(address) ? address : null;
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
  // The settings row is a singleton (`slug: 'global'`), read whole and locked.
  const rows = await tx.$queryRaw<
    Array<{ id: string; slug: string; escalationConfig: Prisma.JsonValue }>
  >`SELECT id, slug, "escalationConfig" FROM ai_orchestration_settings
     WHERE "escalationConfig" IS NOT NULL FOR NO KEY UPDATE`;
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

/**
 * The fallback narrowing for an address SQL cannot search: any email
 * notification step, and any approval step with a notification channel (an
 * empty object is contained in every object, so `{}` matches any channel).
 */
const EMAIL_STEP = JSON.stringify({
  steps: [{ type: 'send_notification', config: { channel: 'email' } }],
});
const APPROVAL_CHANNEL_STEP = JSON.stringify({
  steps: [{ type: 'human_approval', config: { notificationChannel: {} } }],
});

async function eraseFromWorkflows(
  tx: ConfigClient,
  subject: ConfigRecipientsSubject
): Promise<number> {
  const { userId, address } = subject;
  const term = address ? asciiSearchTerm(address) : null;
  const scanFallback = address !== null && term === null;

  // A superset of the rows that name the person; `removeFromDefinition` decides.
  // The text is folded once per row and searched for both the id (a cuid, so
  // already lower-case) and the address.
  const drafts = await tx.$queryRaw<
    Array<{ id: string; name: string; orgId: string | null; draftDefinition: Prisma.JsonValue }>
  >`SELECT w.id, w.name, w."orgId", w."draftDefinition" FROM ai_workflow w
     CROSS JOIN LATERAL (SELECT translate(w."draftDefinition"::text,
       'ABCDEFGHIJKLMNOPQRSTUVWXYZ\u212A', 'abcdefghijklmnopqrstuvwxyzk') AS folded) f
     WHERE w."draftDefinition" IS NOT NULL AND (
       strpos(f.folded, ${userId}) > 0
       OR (${term}::text IS NOT NULL AND strpos(f.folded, ${term}::text) > 0)
       OR (${scanFallback} AND (w."draftDefinition" @> ${EMAIL_STEP}::jsonb
         OR w."draftDefinition" @> ${APPROVAL_CHANNEL_STEP}::jsonb))
     )
     ORDER BY w.id FOR NO KEY UPDATE OF w`;
  const versions = await tx.$queryRaw<
    Array<{
      id: string;
      workflowId: string;
      version: number;
      snapshot: Prisma.JsonValue;
      name: string;
      orgId: string | null;
    }>
  >`SELECT v.id, v."workflowId", v.version, v.snapshot, w.name, w."orgId"
     FROM ai_workflow_version v JOIN ai_workflow w ON w.id = v."workflowId"
     CROSS JOIN LATERAL (SELECT translate(v.snapshot::text,
       'ABCDEFGHIJKLMNOPQRSTUVWXYZ\u212A', 'abcdefghijklmnopqrstuvwxyzk') AS folded) f
     WHERE strpos(f.folded, ${userId}) > 0
       OR (${term}::text IS NOT NULL AND strpos(f.folded, ${term}::text) > 0)
       OR (${scanFallback} AND (v.snapshot @> ${EMAIL_STEP}::jsonb
         OR v.snapshot @> ${APPROVAL_CHANNEL_STEP}::jsonb))
     ORDER BY v."workflowId", v.version FOR NO KEY UPDATE OF v`;

  // One entry per workflow, whether its draft, its versions or both matched.
  const workflows = new Map<
    string,
    {
      name: string;
      orgId: string | null;
      draft: Prisma.JsonValue;
      versions: Array<{ id: string; version: number; snapshot: Prisma.JsonValue }>;
    }
  >();
  for (const row of drafts) {
    workflows.set(row.id, {
      name: row.name,
      orgId: row.orgId,
      draft: row.draftDefinition,
      versions: [],
    });
  }
  for (const row of versions) {
    const entry = workflows.get(row.workflowId) ?? {
      name: row.name,
      orgId: row.orgId,
      draft: null,
      versions: [],
    };
    entry.versions.push({ id: row.id, version: row.version, snapshot: row.snapshot });
    workflows.set(row.workflowId, entry);
  }

  let changed = 0;
  for (const [workflowId, workflow] of workflows) {
    const notificationStepIds = new Set<string>();
    const approvalStepIds = new Set<string>();
    const emptiedStepIds = new Set<string>();
    const record = (change: DefinitionChange) => {
      change.notificationStepIds.forEach((id) => notificationStepIds.add(id));
      change.approvalStepIds.forEach((id) => approvalStepIds.add(id));
      change.emptiedStepIds.forEach((id) => emptiedStepIds.add(id));
    };

    const draft = removeFromDefinition(workflow.draft, subject);
    if (draft) {
      await tx.aiWorkflow.update({
        where: { id: workflowId },
        data: { draftDefinition: draft.definition },
      });
      record(draft);
    }

    const changedVersions: number[] = [];
    for (const version of workflow.versions) {
      const change = removeFromDefinition(version.snapshot, subject);
      if (!change) continue;
      await tx.aiWorkflowVersion.update({
        where: { id: version.id },
        data: { snapshot: change.definition },
      });
      record(change);
      changedVersions.push(version.version);
    }

    // A row the narrowing matched that names someone else changes nothing: no
    // write, no audit row.
    if (!draft && changedVersions.length === 0) continue;
    await tx.aiAdminAuditLog.create({
      data: {
        userId: subject.actorUserId,
        action: 'workflow.recipient_erased',
        entityType: 'workflow',
        entityId: workflowId,
        entityName: workflow.name,
        metadata: {
          reason: ERASURE_REASON,
          orgId: workflow.orgId,
          draft: draft !== null,
          versions: changedVersions,
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
