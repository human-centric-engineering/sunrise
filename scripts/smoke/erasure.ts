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
import { eraseUser } from '@/lib/privacy/erase-user';

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
  let datasetId: string | null = null;
  let costLogId: string | null = null;
  let runId: string | null = null;
  let inboundConversationId: string | null = null;
  let inboundExecutionId: string | null = null;
  let workflowId: string | null = null;

  try {
    // Subject (ADMIN so we also prove a config-creator's createdBy is nulled).
    const subject = await prisma.user.create({
      data: {
        name: `${PREFIX} subject`,
        email: `${PREFIX}-subject-${stamp}@example.com`,
        role: 'ADMIN',
      },
    });
    subjectUserId = subject.id;

    // Org config (retained → createdBy SetNull) + personal data (cascade).
    const agent = await prisma.aiAgent.create({
      data: {
        name: `${PREFIX} agent`,
        slug: `${PREFIX}-agent-${stamp}`,
        description: 'smoke',
        systemInstructions: 'smoke',
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

    // Erase.
    const result = await eraseUser({
      userId: subject.id,
      userEmail: subject.email,
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

    console.log('\n✓ smoke:erasure passed');
  } finally {
    // Self-clean by tracked id. The user + its cascade children may already be
    // gone (erased); deleteMany is a no-op then. All FKs here are Cascade/SetNull,
    // so order can't cause constraint violations.
    if (receiptId)
      await prisma.dataErasureReceipt
        .deleteMany({ where: { id: receiptId } })
        .catch(() => undefined);
    if (auditId)
      await prisma.aiAdminAuditLog.deleteMany({ where: { id: auditId } }).catch(() => undefined);
    if (subjectUserId)
      await prisma.user.deleteMany({ where: { id: subjectUserId } }).catch(() => undefined);
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

main().catch(async (err) => {
  console.error('\n✗ smoke:erasure failed:', err);
  try {
    await prisma.$disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
