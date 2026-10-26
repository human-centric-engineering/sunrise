/**
 * Erasure smoke: configuration, schedules and runs that name the person
 * (t-791, t-804).
 *
 * Proves against real Postgres what the mocked unit tests cannot: that the
 * raw-SQL narrowing `eraseFromConfigRecipients` and `eraseFromRunInputs` use
 * (a `translate()`-folded substring test, with a containment fallback for an
 * address SQL cannot fold) really finds the rows that name the person, and
 * that the rewrite lands on them.
 *
 *   • a verified subject is removed from the escalation list (webhook kept),
 *     from a notification step's `to` in the draft and in a published version,
 *     and from an approval step's `approverUserIds`; a version that names only
 *     a colleague, and a workflow naming an address that merely contains the
 *     subject's, are untouched; one audit row lands per workflow;
 *   • an unverified subject keeps their address everywhere, and is still
 *     removed as an approver;
 *   • a schedule's input template loses the address (blanked where it stood
 *     alone) and stays enabled; a colleague's run paused at an approval loses
 *     the subject's id and address and stays paused; the subject's own run
 *     cascades (t-804); the paused run's supervisor report, step turns,
 *     cached step result and lease events lose them too, and so does a
 *     colleague's run that names them **only** in those side rows — the
 *     narrowing reads them (t-882);
 *   • erasing the escalation list's only recipient leaves it empty and keeps
 *     the webhook.
 *
 * The escalation list lives on the seeded `global` settings row, so its value
 * is saved first and restored on every path. Everything else it creates is a
 * `smoke-test-config-*` row, removed on every path.
 *
 * Skips cleanly (exit 0) when no database is reachable.
 *
 * Run with:
 *   npm run smoke:erasure-config
 */

import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { eraseUser } from '@/lib/privacy/erase-user';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { runAsOrg } from '@/lib/tenancy/context';
import { jsonEquals } from '@/lib/utils/json-equal';

const PREFIX = 'smoke-test-config';
const stamp = Date.now();
const COLLEAGUE = `colleague-${stamp}@example.com`;
const WEBHOOK = 'https://hooks.example.com/smoke-escalation';

async function dbReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

function notify(id: string, to: string | string[]) {
  return {
    id,
    name: id,
    type: 'send_notification',
    config: { channel: 'email', to, subject: 'Hi', bodyTemplate: '{{input}}' },
    nextSteps: [],
  };
}

function approval(id: string, approverUserIds: string[], target?: string) {
  return {
    id,
    name: id,
    type: 'human_approval',
    config: {
      prompt: 'OK?',
      approverUserIds,
      ...(target ? { notificationChannel: { type: 'email', target } } : {}),
    },
    nextSteps: [],
  };
}

function definition(...steps: Prisma.InputJsonObject[]): Prisma.InputJsonObject {
  return { steps, entryStepId: 'n', errorStrategy: 'fail' };
}

function config(def: unknown, stepId: string): Record<string, unknown> | undefined {
  const steps = (def as { steps?: Array<{ id: string; config: Record<string, unknown> }> }).steps;
  return steps?.find((s) => s.id === stepId)?.config;
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure-config skipped — no database reachable.');
    return;
  }

  const settings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { id: true, escalationConfig: true },
  });
  if (!settings) {
    console.log('smoke:erasure-config skipped — no seeded `global` settings row.');
    return;
  }
  const originalEscalation = settings.escalationConfig;

  const userIds: string[] = [];
  const workflowIds: string[] = [];
  const receiptIds: string[] = [];

  try {
    const subject = await prisma.user.create({
      data: {
        name: `${PREFIX} subject`,
        email: `${PREFIX}-subject-${stamp}@example.com`,
        emailVerified: true,
      },
    });
    userIds.push(subject.id);
    const unverified = await prisma.user.create({
      data: {
        name: `${PREFIX} unverified`,
        email: `${PREFIX}-unverified-${stamp}@example.com`,
        emailVerified: false,
      },
    });
    userIds.push(unverified.id);
    const other = await prisma.user.create({
      data: { name: `${PREFIX} other`, email: `${PREFIX}-other-${stamp}@example.com` },
    });
    userIds.push(other.id);

    // As typed by an admin: other case, stray whitespace.
    const typed = `  ${subject.email.toUpperCase()} `;

    await prisma.aiOrchestrationSettings.update({
      where: { id: settings.id },
      data: {
        escalationConfig: {
          emailAddresses: [COLLEAGUE, typed.trim()],
          webhookUrl: WEBHOOK,
          notifyOnPriority: 'high',
        },
      },
    });

    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow`,
        slug: `${PREFIX}-workflow-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: definition(
          notify('n', [typed, COLLEAGUE, unverified.email]),
          approval('ap', [subject.id, other.id, unverified.id], typed)
        ),
      },
    });
    workflowIds.push(workflow.id);
    const v1 = await prisma.aiWorkflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 1,
        orgId: INSTALL_ORG_ID,
        snapshot: definition(notify('n', typed)),
      },
    });
    const v2 = await prisma.aiWorkflowVersion.create({
      data: {
        workflowId: workflow.id,
        version: 2,
        orgId: INSTALL_ORG_ID,
        snapshot: definition(notify('n', COLLEAGUE)),
      },
    });
    await prisma.aiWorkflow.update({
      where: { id: workflow.id },
      data: { publishedVersionId: v1.id },
    });

    // An address that contains the subject's but is someone else's.
    const lookalike = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} lookalike`,
        slug: `${PREFIX}-lookalike-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: definition(notify('n', `x${subject.email}`)),
      },
    });
    workflowIds.push(lookalike.id);

    // What the definitions became at run time (t-804): a schedule's input
    // template, a colleague's run paused at an approval, and the subject's own
    // run, which cascades and must not be read.
    const schedule = await prisma.aiWorkflowSchedule.create({
      data: {
        workflowId: workflow.id,
        name: `${PREFIX} schedule`,
        cronExpression: '0 9 * * 1',
        orgId: INSTALL_ORG_ID,
        inputTemplate: { userEmail: typed, cc: [COLLEAGUE, typed.trim()], region: 'eu' },
      },
    });
    const pausedRun = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        orgId: INSTALL_ORG_ID,
        userId: other.id,
        status: 'paused_for_approval',
        currentStep: 'ap',
        inputData: { userEmail: typed },
        executionTrace: [
          {
            stepId: 'ap',
            stepType: 'human_approval',
            status: 'awaiting_approval',
            output: {
              approverUserIds: [subject.id, other.id],
              notificationChannel: { type: 'email', target: typed },
            },
            input: approval('ap', [subject.id, other.id], typed).config,
          },
        ],
      },
    });
    // What else a run keeps (t-882): on the paused run beside its trace, and on
    // a completed run whose own columns do not name the subject at all.
    await prisma.aiWorkflowExecution.update({
      where: { id: pausedRun.id },
      data: {
        supervisorVerdict: 'concerns',
        supervisorReport: { summary: `Approver ${subject.id} not reached`, cites: [typed] },
      },
    });
    await prisma.aiWorkflowRunningStep.create({
      data: {
        executionId: pausedRun.id,
        orgId: INSTALL_ORG_ID,
        stepId: 'ap',
        label: 'Approve',
        stepType: 'human_approval',
        turns: [{ kind: 'reflect', iteration: 0, draft: typed, converged: false }],
      },
    });
    const sideOnlyRun = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        orgId: INSTALL_ORG_ID,
        userId: other.id,
        status: 'failed',
        inputData: { region: 'eu' },
        executionTrace: [],
      },
    });
    await prisma.aiWorkflowStepDispatch.create({
      data: {
        executionId: sideOnlyRun.id,
        orgId: INSTALL_ORG_ID,
        stepId: 'lookup',
        idempotencyKey: `${sideOnlyRun.id}:lookup`,
        result: { output: { owner: typed, colleague: COLLEAGUE } },
      },
    });
    await prisma.aiWorkflowExecutionLeaseEvent.create({
      data: {
        executionId: sideOnlyRun.id,
        orgId: INSTALL_ORG_ID,
        event: 'force-failed',
        reason: 'admin-force-fail',
        metadata: { actorUserId: subject.id, previousStatus: 'running' },
      },
    });
    // Older than any pass reads without narrowing (they re-read runs written in
    // the last RUN_CLOCK_SKEW_MS), so only the text narrowing can find it.
    await prisma.$executeRaw`UPDATE ai_workflow_execution
      SET "updatedAt" = now() - interval '1 hour' WHERE id = ${sideOnlyRun.id}`;
    const ownRun = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        orgId: INSTALL_ORG_ID,
        userId: subject.id,
        status: 'completed',
        inputData: { userEmail: typed },
        executionTrace: [],
      },
    });

    // ── Verified subject ──────────────────────────────────────────────────
    console.log('verified subject');
    const result = await eraseUser({
      userId: subject.id,
      actorUserId: other.id,
      reason: 'admin_action',
    });
    receiptIds.push(result.receiptId);
    userIds.splice(userIds.indexOf(subject.id), 1);

    const escalation = (
      await prisma.aiOrchestrationSettings.findUniqueOrThrow({ where: { id: settings.id } })
    ).escalationConfig;
    // jsonb stores keys in its own order, so compare as values, not strings.
    check(
      jsonEquals(escalation, {
        emailAddresses: [COLLEAGUE],
        webhookUrl: WEBHOOK,
        notifyOnPriority: 'high',
      }),
      'escalation list lost the subject; colleague, webhook and priority kept'
    );

    const after = await prisma.aiWorkflow.findUniqueOrThrow({ where: { id: workflow.id } });
    check(
      JSON.stringify(config(after.draftDefinition, 'n')?.to) ===
        JSON.stringify([COLLEAGUE, unverified.email]),
      'draft notification step lost the subject, typed in another case'
    );
    check(
      JSON.stringify(config(after.draftDefinition, 'ap')?.approverUserIds) ===
        JSON.stringify([other.id, unverified.id]),
      'draft approval step lost the subject as approver'
    );
    check(
      jsonEquals(config(after.draftDefinition, 'ap')?.notificationChannel ?? null, {
        type: 'email',
      }),
      'draft approval step lost the subject as its notification target, keeping the channel'
    );
    const v1After = await prisma.aiWorkflowVersion.findUniqueOrThrow({ where: { id: v1.id } });
    check(
      config(v1After.snapshot, 'n')?.to === '',
      'published version 1, its only recipient, is left with none'
    );
    const v2After = await prisma.aiWorkflowVersion.findUniqueOrThrow({ where: { id: v2.id } });
    check(
      config(v2After.snapshot, 'n')?.to === COLLEAGUE,
      'version 2, naming only a colleague, is untouched'
    );
    const lookalikeAfter = await prisma.aiWorkflow.findUniqueOrThrow({
      where: { id: lookalike.id },
    });
    check(
      config(lookalikeAfter.draftDefinition, 'n')?.to === `x${subject.email}`,
      'an address that merely contains the subject’s is untouched'
    );

    const audits = await prisma.aiAdminAuditLog.findMany({
      where: { action: 'workflow.recipient_erased', entityId: workflow.id },
    });
    check(audits.length === 1, 'one workflow audit row');
    const meta = audits[0].metadata as Record<string, unknown>;
    check(
      meta.draft === true && JSON.stringify(meta.versions) === '[1]',
      'the audit row names the draft and version 1'
    );
    check(
      !JSON.stringify(audits[0]).toLowerCase().includes(subject.email),
      'the audit row does not hold the address'
    );
    check(
      (await prisma.aiAdminAuditLog.count({
        where: { action: 'workflow.recipient_erased', entityId: lookalike.id },
      })) === 0,
      'no audit row for the untouched workflow'
    );
    check(
      (await prisma.aiAdminAuditLog.count({
        where: {
          action: 'settings.escalation_recipient_erased',
          createdAt: { gte: new Date(stamp) },
        },
      })) >= 1,
      'the escalation change is audited'
    );

    // ── Schedules and runs (t-804) ────────────────────────────────────────
    console.log('schedules and runs');
    const scheduleAfter = await prisma.aiWorkflowSchedule.findUniqueOrThrow({
      where: { id: schedule.id },
    });
    check(
      // jsonb orders keys, so compared structurally.
      isDeepStrictEqual(scheduleAfter.inputTemplate, {
        userEmail: '',
        cc: [COLLEAGUE],
        region: 'eu',
      }),
      "the schedule's template loses the address, blanked where it stood alone"
    );
    check(scheduleAfter.isEnabled, 'and the schedule stays enabled');
    check(
      (await prisma.aiAdminAuditLog.count({
        where: { action: 'workflow_schedule.recipient_erased', entityId: schedule.id },
      })) === 1,
      'with one audit entry'
    );
    const pausedAfter = await prisma.aiWorkflowExecution.findUniqueOrThrow({
      where: { id: pausedRun.id },
    });
    const pausedText = JSON.stringify(pausedAfter).toLowerCase();
    check(
      !pausedText.includes(subject.email.toLowerCase()) && !pausedText.includes(subject.id),
      'a colleague’s paused run no longer holds their address or their id'
    );
    check(
      pausedText.includes(other.id) && pausedAfter.status === 'paused_for_approval',
      'and keeps its other approver, still paused'
    );
    check(
      (await prisma.aiWorkflowExecution.findUnique({ where: { id: ownRun.id } })) === null,
      'their own run went with them'
    );
    const namesSubject = (value: unknown): boolean => {
      const text = JSON.stringify(value).toLowerCase();
      return text.includes(subject.email.toLowerCase()) || text.includes(subject.id);
    };
    check(
      jsonEquals(pausedAfter.supervisorReport, {
        summary: 'Approver [erased] not reached',
        cites: [],
      }),
      'the paused run’s supervisor report loses their id and address (t-882)'
    );
    const turnsAfter = await prisma.aiWorkflowRunningStep.findMany({
      where: { executionId: pausedRun.id },
    });
    check(
      turnsAfter.length === 1 && !namesSubject(turnsAfter[0].turns),
      'and so do its step turns'
    );
    const dispatchAfter = await prisma.aiWorkflowStepDispatch.findMany({
      where: { executionId: sideOnlyRun.id },
    });
    check(
      dispatchAfter.length === 1 &&
        jsonEquals(dispatchAfter[0].result, {
          output: { owner: '[erased]', colleague: COLLEAGUE },
        }),
      'a run naming them only in a cached step result is found, and the result redacted'
    );
    const leaseAfter = await prisma.aiWorkflowExecutionLeaseEvent.findMany({
      where: { executionId: sideOnlyRun.id },
    });
    check(
      leaseAfter.length === 1 &&
        jsonEquals(leaseAfter[0].metadata, {
          actorUserId: '[erased]',
          previousStatus: 'running',
        }),
      'and its lease event no longer names them as the admin who force-failed it'
    );

    // ── Unverified subject ────────────────────────────────────────────────
    console.log('unverified subject');
    const unverifiedResult = await eraseUser({
      userId: unverified.id,
      actorUserId: other.id,
      reason: 'admin_action',
    });
    receiptIds.push(unverifiedResult.receiptId);
    userIds.splice(userIds.indexOf(unverified.id), 1);
    const afterUnverified = await prisma.aiWorkflow.findUniqueOrThrow({
      where: { id: workflow.id },
    });
    check(
      JSON.stringify(config(afterUnverified.draftDefinition, 'n')?.to) ===
        JSON.stringify([COLLEAGUE, unverified.email]),
      'an unverified address is left where it is'
    );
    check(
      JSON.stringify(config(afterUnverified.draftDefinition, 'ap')?.approverUserIds) ===
        JSON.stringify([other.id]),
      'an unverified account is still removed as an approver'
    );

    // ── An address SQL cannot fold: every email step is read instead ──────
    console.log('non-ASCII address');
    const accented = await prisma.user.create({
      data: {
        name: `${PREFIX} accented`,
        email: `${PREFIX}-zoë-${stamp}@example.com`,
        emailVerified: true,
      },
    });
    userIds.push(accented.id);
    const accentedFlow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} accented`,
        slug: `${PREFIX}-accented-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: definition(notify('n', [accented.email.toUpperCase(), COLLEAGUE])),
      },
    });
    workflowIds.push(accentedFlow.id);
    // No email notification step: found only through the approval channel.
    const accentedApproval = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} accented approval`,
        slug: `${PREFIX}-accented-approval-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: definition(approval('ap', [other.id], accented.email)),
      },
    });
    workflowIds.push(accentedApproval.id);
    const accentedResult = await eraseUser({
      userId: accented.id,
      actorUserId: other.id,
      reason: 'admin_action',
    });
    receiptIds.push(accentedResult.receiptId);
    userIds.splice(userIds.indexOf(accented.id), 1);
    const accentedAfter = await prisma.aiWorkflow.findUniqueOrThrow({
      where: { id: accentedFlow.id },
    });
    check(
      jsonEquals(config(accentedAfter.draftDefinition, 'n')?.to ?? null, [COLLEAGUE]),
      'a non-ASCII address typed in upper case is still found and removed'
    );
    const accentedApprovalAfter = await prisma.aiWorkflow.findUniqueOrThrow({
      where: { id: accentedApproval.id },
    });
    check(
      jsonEquals(config(accentedApprovalAfter.draftDefinition, 'ap')?.notificationChannel ?? null, {
        type: 'email',
      }),
      'a non-ASCII address held only as an approval target is found and removed'
    );

    // ── A stored recipient spelled with U+212A KELVIN SIGN ────────────────
    // toLowerCase() folds it to "k", so it is this person's address in code;
    // the SQL fold must find it too.
    console.log('kelvin sign');
    const kate = await prisma.user.create({
      data: {
        name: `${PREFIX} kate`,
        email: `kate-${PREFIX}-${stamp}@example.com`,
        emailVerified: true,
      },
    });
    userIds.push(kate.id);
    const kelvinFlow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} kelvin`,
        slug: `${PREFIX}-kelvin-${stamp}`,
        description: 'smoke',
        orgId: INSTALL_ORG_ID,
        draftDefinition: definition(notify('n', [`\u212A${kate.email.slice(1)}`, COLLEAGUE])),
      },
    });
    workflowIds.push(kelvinFlow.id);
    const kateResult = await eraseUser({
      userId: kate.id,
      actorUserId: other.id,
      reason: 'admin_action',
    });
    receiptIds.push(kateResult.receiptId);
    userIds.splice(userIds.indexOf(kate.id), 1);
    const kelvinAfter = await prisma.aiWorkflow.findUniqueOrThrow({ where: { id: kelvinFlow.id } });
    check(
      jsonEquals(config(kelvinAfter.draftDefinition, 'n')?.to ?? null, [COLLEAGUE]),
      'a recipient spelled with the Kelvin sign is found and removed'
    );

    // ── The only escalation recipient ─────────────────────────────────────
    console.log('only escalation recipient');
    const sole = await prisma.user.create({
      data: {
        name: `${PREFIX} sole`,
        email: `${PREFIX}-sole-${stamp}@example.com`,
        emailVerified: true,
      },
    });
    userIds.push(sole.id);
    await prisma.aiOrchestrationSettings.update({
      where: { id: settings.id },
      data: {
        escalationConfig: { emailAddresses: [sole.email], webhookUrl: WEBHOOK },
      },
    });
    const soleResult = await eraseUser({
      userId: sole.id,
      actorUserId: other.id,
      reason: 'admin_action',
    });
    receiptIds.push(soleResult.receiptId);
    userIds.splice(userIds.indexOf(sole.id), 1);
    const emptied = (
      await prisma.aiOrchestrationSettings.findUniqueOrThrow({ where: { id: settings.id } })
    ).escalationConfig;
    check(
      jsonEquals(emptied, { emailAddresses: [], webhookUrl: WEBHOOK }),
      'the list is left empty and the webhook kept'
    );

    console.log('\n✓ smoke:erasure-config passed');
  } finally {
    await prisma.aiOrchestrationSettings
      .update({
        where: { id: settings.id },
        data: {
          escalationConfig:
            originalEscalation === null
              ? Prisma.JsonNull
              : (originalEscalation as Prisma.InputJsonValue),
        },
      })
      .catch((err) => console.error('could not restore escalationConfig:', err));
    await prisma.aiAdminAuditLog
      .deleteMany({
        where: {
          OR: [
            { action: 'workflow.recipient_erased', entityId: { in: workflowIds } },
            {
              action: 'workflow_schedule.recipient_erased',
              createdAt: { gte: new Date(stamp) },
            },
            {
              action: 'settings.escalation_recipient_erased',
              createdAt: { gte: new Date(stamp) },
            },
          ],
        },
      })
      .catch(() => undefined);
    await prisma.aiWorkflow
      .deleteMany({ where: { id: { in: workflowIds } } })
      .catch(() => undefined);
    await prisma.dataErasureReceipt
      .deleteMany({ where: { id: { in: receiptIds } } })
      .catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

runAsOrg(INSTALL_ORG_ID, main, { source: 'job' }).catch(async (err) => {
  console.error('\n✗ smoke:erasure-config failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
