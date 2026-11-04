/**
 * Account-erasure smoke script.
 *
 * Proves the DB-enforced erasure behavior that mocked unit/integration tests
 * cannot: `ON DELETE CASCADE` removes personal data, `ON DELETE SET NULL`
 * retains org config with a nulled creator, residual `clientIp` is scrubbed,
 * and a `DataErasureReceipt` is written. Runs against the real dev/CI Postgres.
 *
 * It also proves the other edge of the cascade: system-owned inbound data —
 * a third party's SMS thread and the run it started — SURVIVES erasing the
 * operator whose agent and workflow it hangs off. That is the half a mocked
 * test cannot reach, because the deletion it guards against is performed by
 * Postgres rather than by any line of application code (#502).
 *
 * And it proves the contact-form delete (t-767): `ContactSubmission` has no FK,
 * so `eraseUser()` deletes it by address. The subject's address holds a `_`,
 * and a stranger's differs only there — an `ILIKE` would take both, the exact
 * match the service uses takes only the subject's.
 *
 * Skips cleanly (exit 0) when no database is reachable, so it is safe to invoke
 * anywhere — it only does real work where a DB exists (CI's `validate` job,
 * which provisions Postgres + migrations + seeds, and locally with a running
 * DB). It must NOT be wired into `docker build` / `next build` (no DB there).
 *
 * Self-cleaning: creates only `smoke-test-erasure-*` rows and removes whatever
 * it created on every path. Never uses unscoped deletes or touches seed data.
 *
 * Run with:
 *   npm run smoke:erasure
 *   npx tsx --env-file=.env.local scripts/smoke/erasure.ts
 */

import { prisma } from '@/lib/db/client';
import { isRecord } from '@/lib/utils';
import { eraseUser } from '@/lib/privacy/erase-user';
import { findErasedSubjects } from '@/lib/privacy/erased-subjects';
import { eraseWaitlistEntry } from '@/lib/waitlist/erase';
import { waitlistReceiptsOf } from '@/lib/waitlist/subject';
import { PLATFORM_ADMIN_ROLE } from '@/lib/auth/roles';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';
import { ORG_OWNER_ROLE } from '@/lib/tenancy/roles';
import { runAsOrg } from '@/lib/tenancy/context';

const PREFIX = 'smoke-test-erasure';
const stamp = Date.now();

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

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:erasure skipped — no database reachable (DATABASE_URL unset or DB down).');
    return;
  }

  let subjectUserId: string | null = null;
  let agentId: string | null = null;
  let auditId: string | null = null;
  let receiptId: string | null = null;
  const waitlistReceiptIds: string[] = [];
  let holderUserId: string | null = null;
  let datasetId: string | null = null;
  let costLogId: string | null = null;
  let runId: string | null = null;
  let inboundConversationId: string | null = null;
  let inboundExecutionId: string | null = null;
  let workflowId: string | null = null;
  let subjectContactId: string | null = null;
  const waitlistIds: string[] = [];
  let strangerContactId: string | null = null;

  try {
    // Subject (ADMIN so we also prove a config-creator's createdBy is nulled).
    const subject = await prisma.user.create({
      data: {
        name: `${PREFIX} subject`,
        // The `_` is load-bearing: the stranger's contact address below
        // differs only there, so a pattern match would erase their message.
        email: `${PREFIX}_subject-${stamp}@example.com`,
        // Verified: contact messages are matched only to a proven address.
        emailVerified: true,
        role: PLATFORM_ADMIN_ROLE,
      },
    });
    subjectUserId = subject.id;

    // Org membership (§106): the person's data — cascades with them, and the
    // org itself stands. `prisma.user.create` bypasses the auth hook that
    // normally writes this, so it is created here explicitly.
    const membership = await prisma.orgMembership.create({
      data: { orgId: INSTALL_ORG_ID, userId: subject.id, role: ORG_OWNER_ROLE },
    });

    // Org config (retained → createdBy SetNull) + personal data (cascade).
    const agent = await prisma.aiAgent.create({
      data: {
        name: `${PREFIX} agent`,
        slug: `${PREFIX}-agent-${stamp}`,
        description: 'smoke',
        systemInstructions: 'smoke',
        // Both empty: the dynamic-resolution contract. These fixtures never
        // make an LLM call — they exist to be erased/exported — and `provider`
        // used to be filled with 'anthropic' by a column default, which made
        // them inconsistent (model inherited, provider pinned) for no reason.
        provider: '',
        model: '',
        createdBy: subject.id,
      },
    });
    agentId = agent.id;

    const conversation = await prisma.aiConversation.create({
      data: { userId: subject.id, agentId: agent.id, title: 'smoke convo' },
    });

    // A billing record attributed to the subject. Cost rows are the one class
    // here that must survive erasure with the person detached: the spend
    // happened and the books must still show it, but it stops being anyone's.
    const costLog = await prisma.aiCostLog.create({
      data: {
        agentId: agent.id,
        conversationId: conversation.id,
        userId: subject.id,
        model: 'smoke-model',
        provider: 'smoke-provider',
        inputTokens: 1,
        outputTokens: 1,
        // Non-zero on purpose. The assertion below is that erasure does not
        // subtract spend; with a zeroed fixture it would read 0 === 0 and pass
        // even if erasure zeroed the column, which is the failure it exists to
        // catch.
        inputCostUsd: 0.25,
        outputCostUsd: 0.75,
        totalCostUsd: 1,
        operation: 'chat',
      },
    });
    costLogId = costLog.id;
    const message = await prisma.aiMessage.create({
      data: { conversationId: conversation.id, role: 'user', content: 'hi' },
    });

    // A third party's inbound thread and run, on an agent and workflow the
    // subject created. System-owned (`userId: null`) since #502, and they must
    // SURVIVE the subject's erasure: nothing here is the subject's to erase.
    //
    // This is the assertion the whole issue turns on. While these rows carried
    // `userId = trigger.createdBy`, the `Cascade` FK meant erasing one operator
    // silently destroyed every customer conversation routed through any trigger
    // they had configured — `eraseUser()` returned success and the
    // correspondence was gone. Planting them against the subject's own agent
    // and workflow is deliberate: those relations are the remaining paths a
    // cascade could still reach them by.
    const inboundConversation = await prisma.aiConversation.create({
      data: {
        userId: null,
        agentId: agent.id,
        title: `${PREFIX} inbound thread`,
        channel: 'sms',
        provider: 'twilio',
        fromAddress: `+1555${String(stamp).slice(-7)}`,
      },
    });
    inboundConversationId = inboundConversation.id;
    const inboundMessage = await prisma.aiMessage.create({
      data: {
        conversationId: inboundConversation.id,
        role: 'user',
        content: 'third party inbound text',
      },
    });

    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow`,
        slug: `${PREFIX}-workflow-${stamp}`,
        description: 'smoke',
        createdBy: subject.id,
      },
    });
    workflowId = workflow.id;
    const inboundExecution = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'completed',
        inputData: { trigger: { text: 'third party inbound text' } },
        executionTrace: [],
        triggerSource: 'inbound:sms',
        userId: null,
      },
    });
    inboundExecutionId = inboundExecution.id;

    // Retained audit row carrying the subject's IP (residual PII to scrub).
    const audit = await prisma.aiAdminAuditLog.create({
      data: {
        userId: subject.id,
        action: 'agent.create',
        entityType: 'agent',
        clientIp: '203.0.113.7',
      },
    });
    auditId = audit.id;

    // Evaluations (merged from main): dataset = reusable asset (retain/SetNull),
    // run = the user's run history (cascade, results cascade from the run).
    const dataset = await prisma.aiDataset.create({
      data: { userId: subject.id, name: `${PREFIX} dataset`, contentHash: 'smoke-hash' },
    });
    datasetId = dataset.id;
    const run = await prisma.aiEvaluationRun.create({
      data: {
        userId: subject.id,
        name: `${PREFIX} run`,
        subjectKind: 'agent',
        agentId: agent.id,
        datasetId: dataset.id,
        datasetContentHash: 'smoke-hash',
        metricConfigs: [],
      },
    });
    runId = run.id;

    // Contact-form messages: keyed by address alone (no FK), so only the
    // service's own delete reaches them. The stranger's address is the
    // subject's with the `_` replaced — the one row an `ILIKE` would also take.
    const subjectContact = await prisma.contactSubmission.create({
      data: {
        name: `${PREFIX} subject`,
        email: subject.email,
        subject: 'smoke',
        message: 'subject contact message',
      },
    });
    subjectContactId = subjectContact.id;
    const strangerEmail = subject.email.replace('_', 'x');
    const strangerContact = await prisma.contactSubmission.create({
      data: {
        name: `${PREFIX} stranger`,
        email: strangerEmail,
        subject: 'smoke',
        message: 'stranger contact message',
      },
    });
    strangerContactId = strangerContact.id;

    // Waitlist entries (§125): one under the subject's address (no link yet),
    // one linked to the account under another address, and a stranger's.
    // Tenant-owned, written in the install org this script runs in.
    const entry = (email: string, userId: string | null) =>
      prisma.waitlistEntry.create({
        data: { email, userId, consentedAt: new Date(), consentVersion: 'smoke' },
      });
    const subjectEntry = await entry(subject.email, null);
    const linkedEntry = await entry(`${PREFIX}-linked@example.com`, subject.id);
    const strangerEntry = await entry(strangerEmail, null);
    waitlistIds.push(subjectEntry.id, linkedEntry.id, strangerEntry.id);
    // The rows are stored as the contact route stores them (`emailSchema`:
    // trimmed, lower-cased), which is the form erasure matches on. A fixture
    // address outside that form would fail the delete check for the wrong reason.
    check(
      subject.email === subject.email.trim().toLowerCase(),
      'subject address is already in the stored (normalised) form'
    );

    // Erase.
    const result = await eraseUser({
      userId: subject.id,
      actorUserId: subject.id,
      reason: 'self_service',
    });
    receiptId = result.receiptId;

    // Personal data cascaded away.
    check(
      (await prisma.user.findUnique({ where: { id: subject.id } })) === null,
      'user row deleted'
    );
    check(
      (await prisma.aiConversation.findUnique({ where: { id: conversation.id } })) === null,
      'conversation cascade-deleted'
    );
    check(
      (await prisma.aiMessage.findUnique({ where: { id: message.id } })) === null,
      'message cascade-deleted via its conversation'
    );
    check(
      (await prisma.orgMembership.findUnique({ where: { id: membership.id } })) === null,
      'org membership cascade-deleted (personal data)'
    );
    check(
      (await prisma.org.findUnique({ where: { id: INSTALL_ORG_ID } })) !== null,
      'the install org survives erasing one of its OWNERs'
    );

    // Contact submissions: the subject's deleted, the stranger's kept.
    check(
      (await prisma.contactSubmission.findUnique({ where: { id: subjectContact.id } })) === null,
      'subject’s contact submission deleted (no FK — erased by address)'
    );
    check(
      (await prisma.contactSubmission.findUnique({ where: { id: strangerContact.id } })) !== null,
      'stranger’s contact submission survives (exact match, not ILIKE)'
    );

    // Waitlist entries: by address (verified) and by link deleted; the stranger's kept.
    check(
      (await prisma.waitlistEntry.findUnique({ where: { id: subjectEntry.id } })) === null,
      'subject’s waitlist entry deleted (joined under the verified address)'
    );
    check(
      (await prisma.waitlistEntry.findUnique({ where: { id: linkedEntry.id } })) === null,
      'waitlist entry linked to the account deleted'
    );
    check(
      (await prisma.waitlistEntry.findUnique({ where: { id: strangerEntry.id } })) !== null,
      'stranger’s waitlist entry survives (exact match, not ILIKE)'
    );

    // Org config retained, creator de-attributed.
    const agentAfter = await prisma.aiAgent.findUnique({ where: { id: agent.id } });
    check(agentAfter !== null, 'agent retained');
    check(agentAfter?.createdBy === null, 'agent.createdBy nulled (SetNull)');

    // Audit retained, link nulled, IP scrubbed.
    const auditAfter = await prisma.aiAdminAuditLog.findUnique({ where: { id: audit.id } });
    check(auditAfter !== null, 'audit row retained');
    check(auditAfter?.userId === null, 'audit.userId nulled (SetNull)');
    check(auditAfter?.clientIp === null, 'audit.clientIp scrubbed (residual PII)');

    // Cost rows: retained and de-attributed. Deleting them would silently
    // subtract spend that actually happened, and Cascade here would make an
    // erasure request quietly rewrite the books — which is why the FK is
    // SetNull. `conversationId` is separately nulled by the conversation's own
    // cascade, so the row outlives every FK it was created with.
    const costAfter = await prisma.aiCostLog.findUnique({ where: { id: costLog.id } });
    check(costAfter !== null, 'cost row retained (billing record, not personal data)');
    check(costAfter?.userId === null, 'cost.userId nulled (SetNull)');
    check(costAfter?.totalCostUsd === 1, 'cost amount unchanged by erasure (1.0, as created)');

    // Evaluations: dataset retained + de-attributed; run cascade-deleted.
    const datasetAfter = await prisma.aiDataset.findUnique({ where: { id: dataset.id } });
    check(datasetAfter !== null, 'eval dataset retained');
    check(datasetAfter?.userId === null, 'eval dataset.userId nulled (SetNull)');
    check(
      (await prisma.aiEvaluationRun.findUnique({ where: { id: run.id } })) === null,
      'eval run cascade-deleted'
    );

    // System-owned inbound data survives — the erasure is bounded to the
    // subject. A regression here means an operator leaving the company takes
    // the customer correspondence with them.
    const inboundConvAfter = await prisma.aiConversation.findUnique({
      where: { id: inboundConversation.id },
    });
    check(inboundConvAfter !== null, 'third party’s inbound conversation survives the erasure');
    check(
      (await prisma.aiMessage.findUnique({ where: { id: inboundMessage.id } })) !== null,
      'third party’s inbound message survives the erasure'
    );
    check(
      (await prisma.aiWorkflowExecution.findUnique({ where: { id: inboundExecution.id } })) !==
        null,
      'inbound-triggered run survives the erasure'
    );

    // Receipt written without re-introducing PII.
    const receipt = await prisma.dataErasureReceipt.findUnique({ where: { id: result.receiptId } });
    check(receipt !== null, 'erasure receipt written');
    check(receipt?.subjectUserId === subject.id, 'receipt subjectUserId matches');
    check(
      typeof receipt?.subjectEmailHash === 'string' && receipt.subjectEmailHash.length === 64,
      'receipt stores a 64-char sha256 email hash, not the raw email'
    );
    check(receipt?.reason === 'self_service', 'receipt records the reason');
    check(receipt?.subjectKind === 'account', 'an account erasure writes an account receipt');

    // A waitlist-only person (§125 t-975): no account, a confirmed entry,
    // erased through the leave link's writer.
    const leaverEmail = `${PREFIX}-leaver-${stamp}@example.com`;
    const leaver = await prisma.waitlistEntry.create({
      data: {
        email: leaverEmail,
        consentedAt: new Date(),
        consentVersion: 'smoke',
        confirmedAt: new Date(),
      },
    });
    waitlistIds.push(leaver.id);
    const left = await eraseWaitlistEntry({
      entryId: leaver.id,
      actorUserId: null,
      reason: 'self_service',
    });
    if (left) waitlistReceiptIds.push(left.receiptId);
    check(left !== null, 'waitlist erasure returns its receipt');
    check(
      (await prisma.waitlistEntry.findUnique({ where: { id: leaver.id } })) === null,
      'waitlist erasure deletes the entry'
    );
    const waitlistReceipt = left
      ? await prisma.dataErasureReceipt.findUnique({ where: { id: left.receiptId } })
      : null;
    check(
      waitlistReceipt?.subjectKind === 'waitlist' && waitlistReceipt.subjectUserId === null,
      'waitlist receipt is of kind waitlist and names no account'
    );
    check(
      isRecord(waitlistReceipt?.metadata) && waitlistReceipt.metadata.orgId === INSTALL_ORG_ID,
      'waitlist receipt records the org whose list it was'
    );
    check(
      (await eraseWaitlistEntry({
        entryId: leaver.id,
        actorUserId: null,
        reason: 'self_service',
      })) === null,
      'erasing an entry already erased writes no second receipt'
    );
    // A linked entry's receipt is found for its live account through the
    // JSON path the subject export asks by — unverified, so the link alone.
    const holder = await prisma.user.create({
      data: {
        name: `${PREFIX} holder`,
        email: `${PREFIX}-holder-${stamp}@example.com`,
        emailVerified: false,
      },
    });
    holderUserId = holder.id;
    const held = await prisma.waitlistEntry.create({
      data: {
        email: `${PREFIX}-held-${stamp}@example.com`,
        userId: holder.id,
        consentedAt: new Date(),
        consentVersion: 'smoke',
      },
    });
    waitlistIds.push(held.id);
    const heldReceipt = await eraseWaitlistEntry({
      entryId: held.id,
      actorUserId: null,
      reason: 'admin_action',
    });
    if (heldReceipt) waitlistReceiptIds.push(heldReceipt.receiptId);
    const found = await prisma.dataErasureReceipt.findMany({
      where: waitlistReceiptsOf({
        userId: holder.id,
        email: holder.email,
        emailVerified: false,
      }),
      select: { id: true, subjectUserId: true },
    });
    check(
      found.length === 1 &&
        found[0].id === heldReceipt?.receiptId &&
        found[0].subjectUserId === null,
      "a linked entry's receipt is found for its account by linkedUserId, and names none"
    );
    check(
      (
        await prisma.dataErasureReceipt.findMany({
          where: waitlistReceiptsOf({
            userId: holder.id,
            email: leaverEmail,
            emailVerified: false,
          }),
          select: { id: true },
        })
      ).every((r) => r.id !== left?.receiptId),
      'an unverified account does not get the receipt filed under an address it has not proved'
    );

    // The recipient writers do not refuse the address (decided in t-975).
    const refused = await prisma.$transaction((tx) =>
      findErasedSubjects(tx, { addresses: [leaverEmail] })
    );
    check(
      refused.addresses.length === 0,
      'a confirmed waitlist erasure is not refused by the writers'
    );
    // The CHECK holds the kind and the id together.
    const rejects = async (data: { subjectKind: string; subjectUserId: string | null }) => {
      try {
        const row = await prisma.dataErasureReceipt.create({ data: { ...data, reason: 'smoke' } });
        waitlistReceiptIds.push(row.id);
        return false;
      } catch (err) {
        // The CHECK, not any failure: a create that fails for another reason
        // would pass a bare catch.
        return String(err).includes('data_erasure_receipt_subject_kind');
      }
    };
    check(
      await rejects({ subjectKind: 'waitlist', subjectUserId: subject.id }),
      'CHECK rejects a waitlist receipt naming an account'
    );
    check(
      await rejects({ subjectKind: 'account', subjectUserId: null }),
      'CHECK rejects an account receipt naming none'
    );

    console.log('\n✓ smoke:erasure passed');
  } finally {
    // Self-clean by tracked id. The user + its cascade children may already be
    // gone (erased); deleteMany is a no-op then. All FKs here are Cascade/SetNull,
    // so order can't cause constraint violations.
    const receiptIds = [receiptId, ...waitlistReceiptIds].filter((id): id is string => id !== null);
    if (receiptIds.length > 0)
      await prisma.dataErasureReceipt
        .deleteMany({ where: { id: { in: receiptIds } } })
        .catch(() => undefined);
    const contactIds = [subjectContactId, strangerContactId].filter(
      (id): id is string => id !== null
    );
    if (contactIds.length > 0)
      await prisma.contactSubmission
        .deleteMany({ where: { id: { in: contactIds } } })
        .catch(() => undefined);
    if (waitlistIds.length > 0)
      await prisma.waitlistEntry
        .deleteMany({ where: { id: { in: waitlistIds } } })
        .catch(() => undefined);
    if (auditId)
      await prisma.aiAdminAuditLog.deleteMany({ where: { id: auditId } }).catch(() => undefined);
    if (subjectUserId)
      await prisma.user.deleteMany({ where: { id: subjectUserId } }).catch(() => undefined);
    if (holderUserId)
      await prisma.user.deleteMany({ where: { id: holderUserId } }).catch(() => undefined);
    if (runId)
      await prisma.aiEvaluationRun.deleteMany({ where: { id: runId } }).catch(() => undefined);
    if (datasetId)
      await prisma.aiDataset.deleteMany({ where: { id: datasetId } }).catch(() => undefined);
    if (costLogId)
      await prisma.aiCostLog.deleteMany({ where: { id: costLogId } }).catch(() => undefined);
    if (inboundExecutionId)
      await prisma.aiWorkflowExecution
        .deleteMany({ where: { id: inboundExecutionId } })
        .catch(() => undefined);
    if (workflowId)
      await prisma.aiWorkflow.deleteMany({ where: { id: workflowId } }).catch(() => undefined);
    // Deleted before the agent: the conversation is Cascade off `agentId`, so
    // removing the agent first would take it (and its messages) with it — fine
    // for cleanup, but explicit beats incidental.
    if (inboundConversationId)
      await prisma.aiConversation
        .deleteMany({ where: { id: inboundConversationId } })
        .catch(() => undefined);
    if (agentId) await prisma.aiAgent.deleteMany({ where: { id: agentId } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
}

// The install org is the org a smoke runs for: at `multi` a tenant-owned
// read outside any scope refuses rather than reads wide (§107 t-708).
runAsOrg(INSTALL_ORG_ID, main, { source: 'job' }).catch(async (err) => {
  console.error('\n✗ smoke:erasure failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
