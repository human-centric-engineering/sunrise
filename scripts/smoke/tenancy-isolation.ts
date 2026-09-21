/**
 * Smoke: two orgs, one database, and neither can see the other (§107 t-709).
 *
 * Every other control on the row-isolation feature is a file parse or a
 * mocked unit test; none of them has ever run a policy. This is the one
 * that does: a real Postgres, the `org_isolation` policies ENABLED and
 * FORCED, the app connecting as the restricted `NOBYPASSRLS` role, and the
 * actual code paths — the raw-SQL ones no `where` clause reaches included —
 * driven as org A and as org B through the real entry functions, not HTTP.
 *
 * What it proves, as org A after both orgs have equivalent rows:
 *   - every tenant-owned read the admin list endpoints sit on answers A's
 *     rows and none of B's — after asserting the population is non-empty,
 *     since an absence assertion passes for free on an empty set;
 *   - the raw-SQL paths: vector search (`searchKnowledge`), cost reports
 *     (`getCostSummary` / `getCostBreakdown`), conversation semantic search
 *     (`searchConversationEmbeddings`), and the message embedder's INSERT,
 *     which stamps `orgId` from the parent message;
 *   - the shapes t-706 scoped by relation reach: a global root reaching a
 *     tenant table through `include` / `_count`;
 *   - `forEachOrg` sees one org per iteration; a create with no context
 *     throws; a nested create lands in the org; `runAsSystem` sees both;
 *   - the three credential resolvers and the inbound route, called as
 *     nobody, learn B's org from B's row and hand it back / run inside it;
 *   - the t-708 namespaces: `support` in both orgs, refused twice in one;
 *     the same file in both orgs; a default knowledge base per org.
 *
 * Run it against a THROWAWAY database, never the dev one — it creates two
 * orgs and enables nothing itself; the sequence around it is the CI job's
 * (`.context/architecture/ci.md`, "smoke-multi"):
 *
 *   npx prisma migrate deploy                                   (as the owner)
 *   npx tsx prisma/seed.ts                                       (as the owner)
 *   TENANCY_APP_ROLE_PASSWORD=… npx tsx scripts/db/tenancy-role.ts --create
 *   npx tsx scripts/db/tenancy-enable.ts --enable
 *   TENANCY_MODE=multi DATABASE_URL=<app role DSN> npx tsx scripts/smoke/tenancy-isolation.ts
 *
 * It refuses to run at `single` (the policies are dormant there; the whole
 * point is the policy), and skips clean when no database is reachable.
 * Self-cleaning: everything it creates is removed on the way out, under the
 * system scope, whether or not the assertions held.
 */
import '@/prisma/load-env';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/client';
import {
  forEachOrg,
  getTenantContext,
  isMultiTenant,
  runAsOrg,
  runAsSystem,
} from '@/lib/tenancy/context';
import { createOrg } from '@/lib/tenancy/lifecycle';
import { hashApiKey } from '@/lib/auth/api-keys';
import { resolveApiKey } from '@/lib/auth/api-keys';
import { resolveEmbedToken } from '@/lib/embed/auth';
import {
  authenticateMcpRequest,
  generateApiKey as generateMcpKey,
} from '@/lib/orchestration/mcp/auth';
import { getOrCreateDefaultKnowledgeBase } from '@/lib/orchestration/knowledge/document-manager';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { searchConversationEmbeddings } from '@/lib/orchestration/chat/conversation-semantic-search';
import { getCostBreakdown, getCostSummary } from '@/lib/orchestration/llm/cost-reports';
import { signHookPayload } from '@/lib/orchestration/hooks/signing';
import { POST as inboundPost } from '@/app/api/v1/inbound/[channel]/[slug]/route';

const PREFIX = 'smoke-iso';
const stamp = Date.now();
const DIMENSIONS = 1536;
const EMBEDDING_MODEL = 'nomic-embed-text';

async function dbReachable(): Promise<boolean> {
  try {
    await runAsSystem('smoke: reachability', () => prisma.$queryRaw`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  ✗ ${msg}`);
    return;
  }
  console.log(`  ✓ ${msg}`);
}

/** `fn` must reject with a message matching `re`. */
async function rejects(fn: () => Promise<unknown>, re: RegExp, msg: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    check(re.test(err instanceof Error ? err.message : String(err)), msg);
    return;
  }
  check(false, `${msg} — it did not throw`);
}

/**
 * A deterministic unit vector per text: the first 8 chars decide a handful
 * of coordinates, so "org A's topic" and "org B's topic" sit far apart and a
 * query for either lands nearest its own. Good enough for a policy test —
 * the SQL is what is under test, not the embedding.
 */
function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(DIMENSIONS).fill(0);
  for (let i = 0; i < 8 && i < text.length; i++) v[(text.charCodeAt(i) * 31 + i) % DIMENSIONS] = 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * The embedder builds its own HTTP request to the provider's `/embeddings`.
 * Answer it locally, for the one local provider this smoke seeds, and leave
 * every other URL to the real fetch.
 */
function interceptEmbeddings(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/embeddings') && url.startsWith('http://127.0.0.1:')) {
      // The embedder sends a JSON string body; anything else is not ours.
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as { input: string | string[] };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({
        data: inputs.map((text, index) => ({ embedding: fakeEmbedding(text), index })),
        usage: { prompt_tokens: 3 },
      });
    }
    return real(input, init);
  };
  return () => {
    globalThis.fetch = real;
  };
}

interface OrgFixture {
  orgId: string;
  ownerId: string;
  agentId: string;
  kbId: string;
  documentId: string;
  chunkIds: string[];
  conversationId: string;
  messageIds: string[];
  workflowId: string;
  workflowSlug: string;
  triggerSecret: string;
  executionId: string;
  costLogId: string;
  topic: string;
  costUsd: number;
}

/** The same fixture in each org: what B has, A must never see. */
async function seedOrg(label: 'a' | 'b', capabilityId: string, tagId: string): Promise<OrgFixture> {
  const owner = await prisma.user.create({
    data: { name: `${PREFIX} owner ${label}`, email: `${PREFIX}-${label}-${stamp}@example.com` },
  });
  const org = await createOrg({
    slug: `${PREFIX}-${label}-${stamp}`,
    name: `${PREFIX} org ${label}`,
    ownerUserId: owner.id,
  });
  const topic = label === 'a' ? 'alpha aardvark accounting' : 'bravo bison billing';
  const costUsd = label === 'a' ? 0.013 : 0.031;

  return runAsOrg(org.id, async () => {
    // The same slug in both orgs (t-708).
    const agent = await prisma.aiAgent.create({
      data: {
        name: `Support ${label}`,
        slug: 'support',
        description: 'smoke fixture',
        systemInstructions: 'smoke fixture',
        model: '',
        provider: 'anthropic',
        visibility: 'invite_only',
        capabilities: { create: { capabilityId } },
      },
    });
    const kbId = await getOrCreateDefaultKnowledgeBase();
    // The same file in both orgs (t-708): same hash, both `ready`.
    const document = await prisma.aiKnowledgeDocument.create({
      data: {
        slug: `${PREFIX}-doc-${label}`,
        name: `${PREFIX} doc ${label}`,
        fileName: 'shared.md',
        fileHash: `${PREFIX}-shared-hash-${stamp}`,
        status: 'ready',
        scope: 'app',
        chunkCount: 2,
        knowledgeBaseId: kbId,
        uploadedBy: owner.id,
        tags: { create: { tagId } },
      },
    });
    const chunkIds: string[] = [];
    for (const [i, content] of [`${topic} one`, `${topic} two`].entries()) {
      const id = `${PREFIX}-chunk-${label}-${i}-${stamp}`;
      chunkIds.push(id);
      // The seeder's shape: a raw INSERT that reads the org off the document.
      await prisma.$executeRawUnsafe(
        `INSERT INTO ai_knowledge_chunk (
           id, "chunkKey", "documentId", content, "chunkType", "estimatedTokens", metadata,
           embedding, "embeddingModel", "embeddingDimension", "orgId"
         ) VALUES ($1, $2, $3, $4, 'section', 4, '{}'::jsonb, $5::vector, $6, $7,
           (SELECT "orgId" FROM ai_knowledge_document WHERE id = $3))`,
        id,
        `${PREFIX}-${label}-${i}`,
        document.id,
        content,
        `[${fakeEmbedding(content).join(',')}]`,
        EMBEDDING_MODEL,
        DIMENSIONS
      );
    }
    // A conversation with a nested create: the messages must land in the org.
    const conversation = await prisma.aiConversation.create({
      data: {
        agentId: agent.id,
        userId: owner.id,
        title: `${PREFIX} conversation ${label}`,
        messages: {
          create: [
            { role: 'user', content: `Tell me about ${topic}, please.` },
            { role: 'assistant', content: `Here is everything about ${topic} in detail.` },
          ],
        },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    const workflowSlug = `${PREFIX}-wf-${label}-${stamp}`;
    const workflow = await prisma.aiWorkflow.create({
      data: {
        name: `${PREFIX} workflow ${label}`,
        slug: workflowSlug,
        description: 'smoke fixture',
        versions: {
          create: {
            version: 1,
            snapshot: {
              steps: [
                {
                  id: 'guard-1',
                  name: 'Guard',
                  type: 'guard',
                  config: { mode: 'regex', rules: '.*' },
                  nextSteps: [],
                },
              ],
              entryStepId: 'guard-1',
              errorStrategy: 'fail',
            },
          },
        },
      },
      include: { versions: true },
    });
    const version = workflow.versions[0];
    await prisma.aiWorkflow.update({
      where: { id: workflow.id },
      data: { publishedVersionId: version.id },
    });
    const triggerSecret = `${PREFIX}-secret-${label}-${stamp}`;
    await prisma.aiWorkflowTrigger.create({
      data: {
        workflowId: workflow.id,
        channel: 'hmac',
        name: `${PREFIX} trigger ${label}`,
        signingSecret: triggerSecret,
        createdBy: owner.id,
      },
    });
    const execution = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        versionId: version.id,
        status: 'completed',
        inputData: {},
        executionTrace: [],
        userId: owner.id,
      },
    });
    const costLog = await prisma.aiCostLog.create({
      data: {
        agentId: agent.id,
        conversationId: conversation.id,
        model: 'smoke-model',
        provider: 'smoke',
        operation: 'chat',
        inputTokens: 10,
        outputTokens: 10,
        inputCostUsd: costUsd / 2,
        outputCostUsd: costUsd / 2,
        totalCostUsd: costUsd,
      },
    });
    return {
      orgId: org.id,
      ownerId: owner.id,
      agentId: agent.id,
      kbId,
      documentId: document.id,
      chunkIds,
      conversationId: conversation.id,
      messageIds: conversation.messages.map((m) => m.id),
      workflowId: workflow.id,
      workflowSlug,
      triggerSecret,
      executionId: execution.id,
      costLogId: costLog.id,
      topic,
      costUsd,
    };
  });
}

/** What org `who` can see of the two fixtures, by id, through the plain reads. */
async function visible(who: string, a: OrgFixture, b: OrgFixture) {
  return runAsOrg(who, async () => ({
    agents: (await prisma.aiAgent.findMany({ where: { id: { in: [a.agentId, b.agentId] } } })).map(
      (r) => r.id
    ),
    documents: (
      await prisma.aiKnowledgeDocument.findMany({
        where: { id: { in: [a.documentId, b.documentId] } },
      })
    ).map((r) => r.id),
    chunks: (
      await prisma.aiKnowledgeChunk.findMany({
        where: { id: { in: [...a.chunkIds, ...b.chunkIds] } },
        select: { id: true },
      })
    ).map((r) => r.id),
    conversations: (
      await prisma.aiConversation.findMany({
        where: { id: { in: [a.conversationId, b.conversationId] } },
      })
    ).map((r) => r.id),
    messages: (
      await prisma.aiMessage.findMany({
        where: { id: { in: [...a.messageIds, ...b.messageIds] } },
        select: { id: true },
      })
    ).map((r) => r.id),
    executions: (
      await prisma.aiWorkflowExecution.findMany({
        where: { id: { in: [a.executionId, b.executionId] } },
      })
    ).map((r) => r.id),
    costLogs: (
      await prisma.aiCostLog.findMany({ where: { id: { in: [a.costLogId, b.costLogId] } } })
    ).map((r) => r.id),
    supportAgents: (await prisma.aiAgent.findMany({ where: { slug: 'support' } })).map((r) => r.id),
  }));
}

async function main(): Promise<void> {
  if (!(await dbReachable())) {
    console.log('smoke:tenancy-isolation skipped — no database reachable.');
    return;
  }
  if (!isMultiTenant()) {
    console.error(
      'smoke:tenancy-isolation needs TENANCY_MODE=multi with the policies enabled — at single they are dormant and there is nothing to prove.'
    );
    process.exit(1);
  }

  const restoreFetch = interceptEmbeddings();
  let fixtures: OrgFixture[] = [];
  const tagSlug = `${PREFIX}-tag-${stamp}`;

  try {
    // ── Global fixtures: a local embedding provider, a tag, a capability ────
    // AiProviderConfig and KnowledgeTag are global tables (no orgId); the
    // capability is one the seed shipped.
    await prisma.aiProviderConfig.create({
      data: {
        name: `${PREFIX} local embeddings`,
        slug: `${PREFIX}-embed-${stamp}`,
        providerType: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9',
        isLocal: true,
        isActive: true,
      },
    });
    const tag = await prisma.knowledgeTag.create({ data: { slug: tagSlug, name: tagSlug } });
    const capability = await prisma.aiCapability.findFirst({ select: { id: true, slug: true } });
    if (!capability) throw new Error('no seeded capability — run the seed first');

    // ── Two orgs, the same fixture in each ─────────────────────────────────
    const a = await seedOrg('a', capability.id, tag.id);
    const b = await seedOrg('b', capability.id, tag.id);
    fixtures = [a, b];
    console.log(`\n[1] seeded org A (${a.orgId}) and org B (${b.orgId})`);

    // The message embedder's raw INSERT, driven per org: the backfill embeds
    // the assistant messages the org can see and stamps each row's org from
    // the parent message.
    const embeddedA = await runAsOrg(a.orgId, () => backfillMissingEmbeddings(10));
    const embeddedB = await runAsOrg(b.orgId, () => backfillMissingEmbeddings(10));
    check(
      embeddedA.processed === 1 &&
        embeddedB.processed === 1 &&
        embeddedA.failed + embeddedB.failed === 0,
      `the message-embedder backfill embedded one assistant message per org (${embeddedA.processed}/${embeddedB.processed})`
    );

    // ── The populations are non-empty (fp6) ────────────────────────────────
    console.log('\n[2] as org A: its own rows are all there');
    const seenByA = await visible(a.orgId, a, b);
    check(seenByA.agents.includes(a.agentId), 'A sees its agent');
    check(seenByA.documents.includes(a.documentId), 'A sees its document');
    check(
      a.chunkIds.every((id) => seenByA.chunks.includes(id)),
      'A sees both its chunks'
    );
    check(seenByA.conversations.includes(a.conversationId), 'A sees its conversation');
    check(
      a.messageIds.every((id) => seenByA.messages.includes(id)),
      'A sees both its messages'
    );
    check(seenByA.executions.includes(a.executionId), 'A sees its execution');
    check(seenByA.costLogs.includes(a.costLogId), 'A sees its cost log');

    // ── … and none of B's ──────────────────────────────────────────────────
    console.log('\n[3] as org A: nothing of B');
    for (const [name, ids] of Object.entries(seenByA)) {
      const leaked = ids.filter((id) =>
        [
          b.agentId,
          b.documentId,
          ...b.chunkIds,
          b.conversationId,
          ...b.messageIds,
          b.executionId,
          b.costLogId,
        ].includes(id)
      );
      check(leaked.length === 0, `${name}: none of B's rows (${ids.length} seen)`);
    }
    check(
      seenByA.supportAgents.length === 1 && seenByA.supportAgents[0] === a.agentId,
      "A's `support` is the only `support` A can see (t-708 namespace)"
    );
    const seenByB = await visible(b.orgId, a, b);
    check(
      seenByB.supportAgents.length === 1 && seenByB.supportAgents[0] === b.agentId,
      "B's `support` is the only `support` B can see"
    );

    // ── The raw-SQL read paths ─────────────────────────────────────────────
    console.log('\n[4] as org A: the raw-SQL paths');
    const searchA = await runAsOrg(a.orgId, () => searchKnowledge(b.topic, undefined, 10, 1));
    check(searchA.length > 0, `vector search as A returns rows (${searchA.length})`);
    check(
      searchA.every((r) => a.chunkIds.includes(r.chunk.id)),
      "vector search as A, querying B's topic, returns only A's chunks"
    );
    const searchB = await runAsOrg(b.orgId, () => searchKnowledge(b.topic, undefined, 10, 1));
    check(
      searchB.length > 0 && searchB.every((r) => b.chunkIds.includes(r.chunk.id)),
      "vector search as B returns only B's chunks"
    );

    const summaryA = await runAsOrg(a.orgId, () => getCostSummary());
    const summaryB = await runAsOrg(b.orgId, () => getCostSummary());
    const spendOf = (s: Awaited<ReturnType<typeof getCostSummary>>, agentId: string) =>
      s.byAgent.find((row) => row.agentId === agentId)?.monthSpend ?? null;
    check(spendOf(summaryA, a.agentId) !== null, "cost summary as A lists A's agent");
    check(spendOf(summaryA, b.agentId) === null, "cost summary as A does not list B's agent");
    check(
      spendOf(summaryB, b.agentId) !== null && spendOf(summaryB, a.agentId) === null,
      "cost summary as B lists only B's agent"
    );
    const dayAgo = new Date(Date.now() - 86_400_000);
    const tomorrow = new Date(Date.now() + 86_400_000);
    const breakdownA = await runAsOrg(a.orgId, () =>
      getCostBreakdown({ dateFrom: dayAgo, dateTo: tomorrow, groupBy: 'agent' })
    );
    const breakdownAgents = breakdownA.rows.map((r) => r.key);
    check(
      breakdownAgents.includes(a.agentId) && !breakdownAgents.includes(b.agentId),
      "cost breakdown by agent as A carries A's agent and not B's"
    );

    const convSearch = (who: OrgFixture, topic: string) =>
      runAsOrg(who.orgId, () =>
        searchConversationEmbeddings({
          embedding: fakeEmbedding(`Here is everything about ${topic} in detail.`),
          threshold: 1,
          limit: 10,
          callerUserId: who.ownerId,
          includeOwnerless: true,
        })
      );
    const convA = await convSearch(a, b.topic);
    check(convA.length > 0, `conversation search as A returns rows (${convA.length})`);
    check(
      convA.every((r) => r.conversationId === a.conversationId),
      "conversation search as A, querying B's topic, returns only A's conversation"
    );
    const embeddingOrgs = await runAsSystem(
      'smoke: embedding rows',
      () =>
        prisma.$queryRaw<Array<{ messageId: string; orgId: string | null }>>`
        SELECT "messageId", "orgId" FROM ai_message_embedding
        WHERE "messageId" = ANY(${[...a.messageIds, ...b.messageIds]})`
    );
    check(embeddingOrgs.length === 2, `two message-embedding rows exist (${embeddingOrgs.length})`);
    check(
      embeddingOrgs.every(
        (r) => r.orgId === (a.messageIds.includes(r.messageId) ? a.orgId : b.orgId)
      ),
      'each message-embedding row carries the org of its parent message (the raw INSERT)'
    );

    // ── Relation reach from a global root (t-706) ──────────────────────────
    console.log('\n[5] as org A: a global root reaching a tenant table');
    const capsA = await runAsOrg(a.orgId, () =>
      prisma.aiCapability.findMany({
        where: { id: capability.id },
        include: { agents: { where: { agentId: { in: [a.agentId, b.agentId] } } } },
      })
    );
    const boundAgents = capsA[0]?.agents.map((x) => x.agentId) ?? [];
    check(
      boundAgents.length === 1 && boundAgents[0] === a.agentId,
      "capability → agents as A: A's binding only"
    );
    const tagsA = await runAsOrg(a.orgId, () =>
      prisma.knowledgeTag.findMany({
        where: { id: tag.id },
        include: { _count: { select: { documents: true } } },
      })
    );
    check(
      tagsA[0]?._count.documents === 1,
      `tag → _count.documents as A is 1 (both orgs tagged the tag; got ${tagsA[0]?._count.documents})`
    );

    // ── Scopes ─────────────────────────────────────────────────────────────
    console.log('\n[6] scopes');
    const perOrg = new Map<string, number>();
    await forEachOrg(async (orgId) => {
      if (orgId !== a.orgId && orgId !== b.orgId) return;
      perOrg.set(orgId, await prisma.aiAgent.count({ where: { slug: 'support' } }));
    });
    check(
      perOrg.get(a.orgId) === 1 && perOrg.get(b.orgId) === 1,
      'forEachOrg: each iteration counts only its own `support`'
    );
    await rejects(
      () =>
        prisma.aiAgent.create({
          data: {
            name: 'x',
            slug: 'nobody',
            description: '',
            systemInstructions: '',
            model: '',
            provider: 'anthropic',
          },
        }),
      /No tenant context/,
      'a create with no context throws before any SQL'
    );
    check(getTenantContext() === null, 'nothing leaked a context onto the caller');
    const nestedOrgs = await runAsSystem('smoke: nested-create check', () =>
      prisma.aiMessage.findMany({ where: { id: { in: a.messageIds } }, select: { orgId: true } })
    );
    check(
      nestedOrgs.length === 2 && nestedOrgs.every((m) => m.orgId === a.orgId),
      'a nested create (conversation → messages) landed both messages in A'
    );
    const bothSupports = await runAsSystem('smoke: both orgs', () =>
      prisma.aiAgent.count({ where: { slug: 'support', orgId: { in: [a.orgId, b.orgId] } } })
    );
    check(bothSupports === 2, 'runAsSystem sees both orgs’ `support`');

    // ── The t-708 namespaces ───────────────────────────────────────────────
    console.log('\n[7] namespaces');
    await rejects(
      () =>
        runAsOrg(a.orgId, () =>
          prisma.aiAgent.create({
            data: {
              name: 'Support again',
              slug: 'support',
              description: '',
              systemInstructions: '',
              model: '',
              provider: 'anthropic',
            },
          })
        ),
      /Unique constraint|orgId_slug/,
      'a second `support` in one org is refused by the per-org key'
    );
    const sameFile = await runAsSystem('smoke: same file both orgs', () =>
      prisma.aiKnowledgeDocument.count({
        where: { fileHash: `${PREFIX}-shared-hash-${stamp}`, status: 'ready' },
      })
    );
    check(sameFile === 2, 'the same file is `ready` in both orgs (dedupe is per org)');
    check(
      a.kbId !== b.kbId && a.kbId !== 'kb_default' && b.kbId !== 'kb_default',
      "each org got its own default knowledge base, neither the install org's `kb_default`"
    );
    await rejects(
      () =>
        runAsOrg(a.orgId, () =>
          prisma.aiKnowledgeBase.create({
            data: { slug: 'second-default', name: 'x', isDefault: true },
          })
        ),
      /Unique constraint|single_default/,
      'a second default knowledge base in one org is refused'
    );

    // ── Credentials minted in B, resolved as nobody ────────────────────────
    console.log('\n[8] credentials minted in B, resolved by nobody');
    const rawApiKey = `sk_${PREFIX}_${stamp}_${'b'.repeat(40)}`;
    const embedTokenValue = `${PREFIX}-embed-${stamp}`;
    const mcpKey = generateMcpKey();
    await runAsOrg(b.orgId, async () => {
      await prisma.aiApiKey.create({
        data: {
          userId: b.ownerId,
          name: `${PREFIX} key`,
          keyHash: hashApiKey(rawApiKey),
          keyPrefix: rawApiKey.slice(0, 8),
          scopes: ['chat'],
        },
      });
      await prisma.aiAgentEmbedToken.create({
        data: {
          agentId: b.agentId,
          token: embedTokenValue,
          allowedOrigins: [],
          createdBy: b.ownerId,
        },
      });
      await prisma.mcpApiKey.create({
        data: {
          name: `${PREFIX} mcp`,
          keyHash: mcpKey.hash,
          keyPrefix: mcpKey.prefix,
          scopes: ['tools:list'],
          createdBy: b.ownerId,
        },
      });
    });
    check(getTenantContext() === null, 'no context is entered before the resolvers run');
    const apiKeyResult = await resolveApiKey(
      new NextRequest('http://localhost/api/v1/x', {
        headers: { authorization: `Bearer ${rawApiKey}` },
      })
    );
    check(
      apiKeyResult?.orgId === b.orgId,
      'resolveApiKey, as nobody, answers B for a key minted in B'
    );
    const embedResult = await resolveEmbedToken(embedTokenValue, '10.0.0.1');
    check(
      embedResult?.orgId === b.orgId && embedResult.agentId === b.agentId,
      'resolveEmbedToken, as nobody, answers B and B’s agent'
    );
    const mcpResult = await authenticateMcpRequest(mcpKey.plaintext, '10.0.0.1', 'smoke');
    check(mcpResult?.orgId === b.orgId, 'authenticateMcpRequest, as nobody, answers B');
    check(getTenantContext() === null, 'the resolvers hand the org back without entering it');

    // ── The inbound route, as nobody, for B's workflow ─────────────────────
    console.log("\n[9] the inbound route fires B's trigger and runs inside B");
    const rawBody = JSON.stringify({ eventId: `${PREFIX}-evt-${stamp}`, hello: 'b' });
    const { timestamp, signature } = signHookPayload(b.triggerSecret, rawBody);
    const response = await inboundPost(
      new NextRequest(`http://localhost:3000/api/v1/inbound/hmac/${b.workflowSlug}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sunrise-signature': signature,
          'x-sunrise-timestamp': timestamp,
          'x-forwarded-for': '10.0.0.2',
        },
        body: rawBody,
      }),
      { params: Promise.resolve({ channel: 'hmac', slug: b.workflowSlug }) }
    );
    const inboundBody = (await response.json()) as {
      success: boolean;
      data?: { executionId?: string };
    };
    check(
      response.status === 202 && inboundBody.success,
      `the inbound route accepted the signed call (${response.status})`
    );
    const inboundExecutionId = inboundBody.data?.executionId ?? null;
    const inboundInB = inboundExecutionId
      ? await runAsOrg(b.orgId, () =>
          prisma.aiWorkflowExecution.count({ where: { id: inboundExecutionId } })
        )
      : 0;
    const inboundInA = inboundExecutionId
      ? await runAsOrg(a.orgId, () =>
          prisma.aiWorkflowExecution.count({ where: { id: inboundExecutionId } })
        )
      : 0;
    check(
      inboundInB === 1 && inboundInA === 0,
      'the execution it enqueued is B’s and invisible to A'
    );
    // The engine drain it started is fire-and-forget; let it settle before cleanup.
    await new Promise((r) => setTimeout(r, 1500));

    if (failures > 0) throw new Error(`${failures} check(s) failed`);
    console.log('\n✓ smoke:tenancy-isolation passed');
  } finally {
    restoreFetch();
    // Everything this smoke creates carries the prefix, and an org's
    // tenant-owned rows cascade with it — so a run that died half-way
    // through seeding (a dropped policy refuses the first create) leaves
    // nothing behind either.
    await runAsSystem('smoke: cleanup', async () => {
      for (const f of fixtures) {
        await prisma.aiWorkflowExecution.deleteMany({ where: { workflowId: f.workflowId } });
        await prisma.aiCostLog.deleteMany({ where: { id: f.costLogId } });
      }
      await prisma.org.deleteMany({ where: { slug: { startsWith: `${PREFIX}-` } } });
      await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX}-` } } });
      await prisma.knowledgeTag.deleteMany({ where: { slug: { startsWith: `${PREFIX}-` } } });
      await prisma.aiProviderConfig.deleteMany({ where: { slug: { startsWith: `${PREFIX}-` } } });
    }).catch((err: unknown) => {
      console.error('cleanup failed — remove the smoke-iso rows by hand', err);
    });
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n✗ smoke:tenancy-isolation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
