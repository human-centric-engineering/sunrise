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
 *     the same file in both orgs; a default knowledge base per org;
 *   - a per-org platform job driven through the registry (§108 t-711): the
 *     zombie reaper, with a stale execution seeded in each org, reaps both
 *     and every lease event it writes carries that org — the assertion that
 *     fails on a `NULL`-org row, which is what a job run under the system
 *     scope would have produced;
 *   - the platform agents (§116 t-724): an org made by `createOrg` has its
 *     own twelve, and none of the install org's four install-only ones,
 *     with no step but its creation; in it the clean-up upload, an MCP tool
 *     call, case generation and an evaluation run with a built-in judge all
 *     run, against a local chat model the smoke answers itself, and every
 *     row they produce carries that org;
 *   - the patterns knowledge (§116 t-726, t-733): the install org's alone —
 *     an org made by `createOrg` gets no copy. Loaded by hand into two orgs,
 *     each copy lands in that org's own knowledge base holding the same chunk
 *     keys as the install org's; one org's embed run embeds its copy and
 *     nobody else's, and its search — plain, and as a restricted agent's
 *     `search_knowledge_base` tool call — with the other org's identical copy
 *     embedded beside it, reads only chunks that carry its org;
 *   - the built-in workflow templates (§116 t-727): an org made by
 *     `createOrg` lists all twelve, served from code; one org's custom
 *     template is not in another's list; and a workflow created from a
 *     built-in, with its first version, carries the creating org.
 *   - a workflow slug (§107 t-728): a slug only A holds is invisible to a
 *     plain read in B, but `isWorkflowSlugTaken` / `findFreeWorkflowSlug`
 *     see it, and B creates on the slug it is given;
 *   - global config in use (§107 t-731): an agent in B using a provider, a
 *     model, a tag and a profile is counted by the in-use checks asked from
 *     A, which name none of B's rows;
 *   - shared settings change only from the install org (§107 t-751): the
 *     three built-in capabilities that write provider models, dispatched as
 *     B's workflow would, refuse and change nothing, and so do they with no
 *     org entered at all; from the install org and a system scope they
 *     write; and the guard's option, called with an unbound admin API key,
 *     lets a write through from no org;
 *   - a person's export and erasure (§107 t-748): a member of A and B, with
 *     a conversation and a memory in each, exports from inside A (a session)
 *     and from no org (an admin API key), and the bundle holds both orgs'
 *     rows and no one else's; one person erased from inside A and another
 *     from no org leave no conversation or memory in either org;
 *   - the org export and erasure (§106 t-735, t-730): B's export, asked
 *     from inside A (an admin's session) and from no org (an admin API key),
 *     holds B's rows and none of A's; B, holding a knowledge base with
 *     documents and chunks, is erased from inside A, and no row in any
 *     tenant-owned table carries its org afterwards, A's rows untouched; A is
 *     then erased from no org the same way.
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
 * system scope, whether or not the assertions held — and a cleanup that
 * fails, fails the run.
 */
import '@/prisma/load-env';
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import {
  forEachOrg,
  getTenantContext,
  isMultiTenant,
  runAsOrg,
  runAsSystem,
} from '@/lib/tenancy/context';
import { createOrg } from '@/lib/tenancy/lifecycle';
import {
  agentProfileUsage,
  capabilityAgentUsage,
  knowledgeTagCounts,
  knowledgeTagUsage,
  modelAgentUsage,
  modelUsageKey,
  providerModelUsage,
  providerUsage,
} from '@/lib/orchestration/admin/global-config-usage';
import {
  findFreeWorkflowSlug,
  isWorkflowSlugTaken,
} from '@/lib/orchestration/workflows/slug-availability';
import { tenantOwnedModels } from '@/lib/tenancy/classification';
import { exportOrgData } from '@/lib/privacy/export-org';
import { eraseOrg } from '@/lib/privacy/erase-org';
import { exportUserData } from '@/lib/privacy/export-user';
import { eraseUser } from '@/lib/privacy/erase-user';
import { writeOrgProviderPolicy } from '@/lib/tenancy/org-settings';
import { forgetOrgProviderPolicy } from '@/lib/orchestration/llm/org-provider-policy';
import { hashApiKey } from '@/lib/auth/api-keys';
import { resolveApiKey } from '@/lib/auth/api-keys';
import { resolveEmbedToken } from '@/lib/embed/auth';
import {
  authenticateMcpRequest,
  generateApiKey as generateMcpKey,
} from '@/lib/orchestration/mcp/auth';
import { getOrCreateDefaultKnowledgeBase } from '@/lib/orchestration/knowledge/document-manager';
import { listWorkflowTemplates } from '@/lib/orchestration/workflows/template-catalogue';
import { createInitialVersion } from '@/lib/orchestration/workflows/version-service';
import { BUILTIN_WORKFLOW_TEMPLATES } from '@/prisma/seeds/data/templates';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { backfillMissingEmbeddings } from '@/lib/orchestration/chat/message-embedder';
import { searchConversationEmbeddings } from '@/lib/orchestration/chat/conversation-semantic-search';
import { getCostBreakdown, getCostSummary } from '@/lib/orchestration/llm/cost-reports';
import { signHookPayload } from '@/lib/orchestration/hooks/signing';
import { POST as inboundPost } from '@/app/api/v1/inbound/[channel]/[slug]/route';
import { withAdminAuth } from '@/lib/auth/guards';
import { createFlag } from '@/lib/feature-flags';
import { PLATFORM_JOBS } from '@/lib/orchestration/maintenance/platform-jobs';
import { createDocumentForCleanup } from '@/lib/orchestration/knowledge/document-manager';
import { callMcpTool, clearMcpToolCache } from '@/lib/orchestration/mcp/tool-registry';
import { generateCases } from '@/lib/orchestration/evaluations/synthesis/case-generator';
import { processPendingEvaluationRuns } from '@/lib/orchestration/evaluations/run-worker';
import { hashDatasetCases } from '@/lib/orchestration/evaluations/datasets/hash';
import { platformAgentsForOrg } from '@/lib/orchestration/agents/platform-agents';
import { capabilityDispatcher } from '@/lib/orchestration/capabilities/dispatcher';
import {
  invalidateAgentAccess,
  resolveAgentDocumentAccess,
} from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { registerBuiltInCapabilities } from '@/lib/orchestration/capabilities/registry';
import {
  embedChunks,
  loadPatternsChunks,
  materialisePatternsKnowledge,
} from '@/lib/orchestration/knowledge/seeder';
import {
  PATTERNS_DOCUMENT_SLUG,
  PATTERNS_TAG_SLUG,
} from '@/lib/orchestration/knowledge/patterns-knowledge';
import { INSTALL_ORG_ID } from '@/lib/tenancy/constants';

const PREFIX = 'smoke-iso';
const stamp = Date.now();
const DIMENSIONS = 1536;
const EMBEDDING_MODEL = 'nomic-embed-text';
/** The local provider this smoke seeds, and answers itself: embeddings and chat. */
const LOCAL_PROVIDER_SLUG = `${PREFIX}-embed-${stamp}`;
const CHAT_MODEL = 'smoke-chat';
/** What the fake judge scores every case — the number the run must carry back. */
const JUDGE_SCORE = 0.8;

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
 * What the local chat model answers, chosen by the system prompt it is sent:
 * the case generator gets two cases, a judge gets a score, anything else a
 * sentence. The platform agents' prompts are what is under test here, not a
 * model, so a canned answer in the shape each one parses is enough.
 */
function fakeChatAnswer(system: string): string {
  if (system.includes('test-case generator')) {
    return JSON.stringify({
      cases: [
        { input: 'What is prompt chaining?', expectedOutput: 'Splitting a task into steps.' },
        { input: 'When should I route?', expectedOutput: 'When inputs differ by kind.' },
      ],
    });
  }
  if (system.includes('Judge in an evaluation pipeline')) {
    return JSON.stringify({
      evaluation_steps: ['Step 1: restated', 'Step 2: focus', 'Step 3: match'],
      score: JUDGE_SCORE,
      reasoning: 'On topic.',
    });
  }
  return 'Prompt chaining splits a task into a sequence of smaller steps.';
}

/** An OpenAI-compatible completion, streamed or not, carrying `text`. */
function fakeChatResponse(text: string, stream: boolean): Response {
  const base = { id: `${PREFIX}-chat`, created: 0, model: CHAT_MODEL };
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 };
  if (!stream) {
    return Response.json({
      ...base,
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    });
  }
  const chunk = (payload: object) => `data: ${JSON.stringify({ ...base, ...payload })}\n\n`;
  const body =
    chunk({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    }) +
    chunk({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }) +
    chunk({ object: 'chat.completion.chunk', choices: [], usage }) +
    'data: [DONE]\n\n';
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

/**
 * The embedder and the chat provider build their own HTTP requests. Answer
 * `/embeddings` and `/chat/completions` locally, for the one local provider
 * this smoke seeds, and leave every other URL to the real fetch.
 *
 * The one exception is email: the clean-up upload in [11] sends its "ready"
 * email fire-and-forget, and a checkout whose `.env.local` holds a Resend key
 * would really send it. Resend is answered here too, so the smoke never
 * emails anyone.
 */
function interceptEmbeddings(): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      return Response.json({ id: `${PREFIX}-email` });
    }
    if (url.endsWith('/chat/completions') && url.startsWith('http://127.0.0.1:')) {
      const raw = typeof init?.body === 'string' ? init.body : '{}';
      const body = JSON.parse(raw) as {
        stream?: boolean;
        messages?: Array<{ role: string; content: unknown }>;
      };
      const system = (body.messages ?? [])
        .filter((m) => m.role === 'system')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
      return fakeChatResponse(fakeChatAnswer(system), body.stream === true);
    }
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
async function seedOrg(
  label: 'a' | 'b',
  capabilityId: string,
  tagId: string,
  providerId: string
): Promise<OrgFixture> {
  const owner = await prisma.user.create({
    data: { name: `${PREFIX} owner ${label}`, email: `${PREFIX}-${label}-${stamp}@example.com` },
  });
  const org = await createOrg({
    slug: `${PREFIX}-${label}-${stamp}`,
    name: `${PREFIX} org ${label}`,
    ownerUserId: owner.id,
  });
  // At multi a new org may call no provider until it is granted one (§120
  // t-742). Both orgs get the smoke's local provider, as an operator would —
  // and, as the grant route does, the cached policy is dropped after the
  // write: `createOrg`'s reconcile has already read (and cached) this org's
  // policy while it had no grants (t-746's cleanup-agent pick).
  await writeOrgProviderPolicy(org.id, { approved: [providerId] });
  forgetOrgProviderPolicy(org.id);
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
  // Section [11] exposes one capability over MCP; the row is global, so it is
  // put back as it was.
  let mcpExposure: { isEnabled: boolean } | null = null;
  let mcpExposureCapabilityId: string | null = null;
  const tagSlug = `${PREFIX}-tag-${stamp}`;

  try {
    // ── Global fixtures: a local embedding provider, a tag, a capability ────
    // AiProviderConfig and KnowledgeTag are global tables (no orgId); the
    // capability is one the seed shipped.
    const localProvider = await prisma.aiProviderConfig.create({
      data: {
        name: `${PREFIX} local embeddings`,
        slug: LOCAL_PROVIDER_SLUG,
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
    const a = await seedOrg('a', capability.id, tag.id, localProvider.id);
    const b = await seedOrg('b', capability.id, tag.id, localProvider.id);
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

    // ── A per-org platform job through the registry (§108 t-711) ──────────
    console.log('\n[10] a per-org platform job, driven through the registry');
    // One stale `running` execution per org, older than the reaper's 30-minute
    // threshold. `updatedAt` is `@updatedAt`, which an explicit value on
    // create overrides.
    const staleAt = new Date(Date.now() - 45 * 60 * 1000);
    const staleIds: Record<string, string> = {};
    for (const f of [a, b]) {
      const stale = await runAsOrg(f.orgId, () =>
        prisma.aiWorkflowExecution.create({
          data: {
            workflowId: f.workflowId,
            status: 'running',
            inputData: {},
            executionTrace: [],
            userId: f.ownerId,
            leaseToken: `${PREFIX}-lease-${stamp}`,
            leaseExpiresAt: staleAt,
            updatedAt: staleAt,
          },
          select: { id: true },
        })
      );
      staleIds[f.orgId] = stale.id;
    }
    const reaper = PLATFORM_JOBS.find((job) => job.name === 'zombieReaper');
    check(reaper?.scope === 'per-org', 'the zombie reaper is registered per-org');
    // Started inside a foreign org on purpose: the admin route's guard enters
    // the caller's org before the tick runs, and the job must ignore it.
    const reaped = reaper
      ? await runAsOrg(a.orgId, () => reaper.run())
      : { result: null, foundWork: false };
    // The folded summary is `unknown` to the caller; read the two counters
    // it must carry without asserting a shape on the rest.
    const counter = (key: 'orgs' | 'reaped'): number | null => {
      if (typeof reaped.result !== 'object' || reaped.result === null) return null;
      const value: unknown = Reflect.get(reaped.result, key);
      return typeof value === 'number' ? value : null;
    };
    const orgsRun = counter('orgs');
    const reapedCount = counter('reaped');
    check(orgsRun !== null && orgsRun >= 2, `the job ran once per org (${String(orgsRun)} orgs)`);
    check(
      reapedCount !== null && reapedCount >= 2,
      `it reaped both orgs' stale executions (${String(reapedCount)})`
    );
    check(reaped.foundWork === true, 'and reported work, so the idle gate stays disarmed');
    for (const f of [a, b]) {
      const row = await runAsOrg(f.orgId, () =>
        prisma.aiWorkflowExecution.findUnique({
          where: { id: staleIds[f.orgId] },
          select: { status: true },
        })
      );
      check(row?.status === 'failed', `org ${f === a ? 'A' : 'B'}'s stale execution is now failed`);
    }
    // The release events are fire-and-forget inside the reaper; let them land.
    await new Promise((r) => setTimeout(r, 1000));
    const leaseEvents = await runAsSystem('smoke: lease-event rows', () =>
      prisma.aiWorkflowExecutionLeaseEvent.findMany({
        where: { executionId: { in: Object.values(staleIds) }, event: 'released' },
        select: { executionId: true, orgId: true },
      })
    );
    check(leaseEvents.length === 2, `two release events were written (${leaseEvents.length})`);
    check(
      leaseEvents.every((e) => e.orgId !== null && staleIds[e.orgId] === e.executionId),
      'each release event carries the org of the execution it released — none is NULL'
    );
    check(getTenantContext() === null, 'the job left no context on the caller');

    // ── Platform agents in an org made by createOrg (§116 t-724) ──────────
    console.log('\n[11] platform agents: org B has its own, and they run there');
    const everyOrg = platformAgentsForOrg(b.orgId).map((d) => d.slug);
    const installOnly = platformAgentsForOrg(INSTALL_ORG_ID)
      .map((d) => d.slug)
      .filter((slug) => !everyOrg.includes(slug));
    const platformRows = (orgId: string) =>
      runAsOrg(orgId, () =>
        prisma.aiAgent.findMany({
          where: { isSystem: true },
          select: { id: true, slug: true, orgId: true, isActive: true },
        })
      );
    const inB = await platformRows(b.orgId);
    const inA = await platformRows(a.orgId);
    const inInstall = await platformRows(INSTALL_ORG_ID);
    check(
      everyOrg.length === 12 && installOnly.length === 4,
      `the registry gives every org 12 and the install org 4 more (${everyOrg.length}/${installOnly.length})`
    );
    check(
      inB.length === everyOrg.length && everyOrg.every((slug) => inB.some((r) => r.slug === slug)),
      `B has every one of the ${everyOrg.length} with no step but createOrg (${inB.length} system agents)`
    );
    check(
      inB.every((r) => r.orgId === b.orgId && r.isActive),
      'each is an active row of B’s own'
    );
    check(
      installOnly.every((slug) => !inB.some((r) => r.slug === slug)),
      `B has none of the install-only agents (${installOnly.join(', ')})`
    );
    check(
      installOnly.every((slug) => inInstall.some((r) => r.slug === slug)) &&
        inInstall.length === everyOrg.length + installOnly.length,
      `the install org still has all ${everyOrg.length + installOnly.length}`
    );
    check(
      inA.length === everyOrg.length && !inA.some((r) => inB.some((x) => x.id === r.id)),
      'A has its own instances — not one row shared with B'
    );
    const idOf = (slug: string) => inB.find((r) => r.slug === slug)?.id ?? 'missing';

    // The model is the org's to choose (org-tunable): point the four agents
    // these paths drive at the local model this smoke answers.
    // A chat agent of B's as the subject: the pattern advisor was, until it
    // became install-only (t-733). Evaluation runs refuse a judge.
    const subjectSlug = 'cleanup-agent';
    const judgeSlug = 'eval-judge-relevance';
    await runAsOrg(b.orgId, () =>
      prisma.aiAgent.updateMany({
        where: { slug: { in: [subjectSlug, judgeSlug, 'eval-case-generator', 'cleanup-agent'] } },
        data: { provider: LOCAL_PROVIDER_SLUG, model: CHAT_MODEL },
      })
    );

    // The clean-up upload: a document in `cleaning`, and a conversation with
    // B's clean-up assistant.
    const kickoff = await runAsOrg(b.orgId, () =>
      createDocumentForCleanup(
        'Some notes to clean.\n\nWith a second paragraph.',
        `${PREFIX}-notes-${stamp}.md`,
        b.ownerId
      )
    );
    const cleanupConversation = await runAsSystem('smoke: cleanup conversation', () =>
      prisma.aiConversation.findUnique({
        where: { id: kickoff.conversationId },
        select: { agentId: true, orgId: true },
      })
    );
    check(
      cleanupConversation?.agentId === idOf('cleanup-agent') &&
        cleanupConversation.orgId === b.orgId &&
        kickoff.document.orgId === b.orgId,
      'the clean-up upload opened a conversation with B’s clean-up assistant, in B'
    );

    // An MCP tool call: dispatched as B's mcp-system. `McpExposedTool` is a
    // global table, so the exposure is put back as it was on the way out.
    const costCapability = await prisma.aiCapability.findUnique({
      where: { slug: 'estimate_workflow_cost' },
      select: { id: true },
    });
    if (!costCapability) throw new Error('estimate_workflow_cost is not seeded — run the seed');
    mcpExposure = await prisma.mcpExposedTool.findUnique({
      where: { capabilityId: costCapability.id },
    });
    await prisma.mcpExposedTool.upsert({
      where: { capabilityId: costCapability.id },
      create: { capabilityId: costCapability.id, isEnabled: true },
      update: { isEnabled: true },
    });
    mcpExposureCapabilityId = costCapability.id;
    clearMcpToolCache();
    const mcpCall = await runAsOrg(b.orgId, () =>
      callMcpTool(
        'estimate_workflow_cost',
        { description: 'Summarise then classify', estimated_steps: 2, model_tier: 'budget' },
        { userId: b.ownerId }
      )
    );
    const mcpText = mcpCall.content[0]?.type === 'text' ? mcpCall.content[0].text : '';
    check(
      mcpCall.isError !== true,
      `an MCP tool call in B dispatched as B’s mcp-system (${mcpText.slice(0, 60)})`
    );

    // Case generation: B's generator proposes cases for B's subject agent.
    const generated = await runAsOrg(b.orgId, () =>
      generateCases({
        agentId: idOf(subjectSlug),
        userId: b.ownerId,
        mode: 'description',
        count: 2,
        domainPrompt: 'An assistant that explains agentic design patterns to engineers.',
      })
    );
    check(
      generated.cases.length === 2,
      `B's case generator proposed ${generated.cases.length} cases`
    );

    // An evaluation run scored by a built-in judge, drained by the worker.
    const evalCases = [{ position: 0, input: 'What is prompt chaining?', expectedOutput: null }];
    const evalRunId = await runAsOrg(b.orgId, async () => {
      const dataset = await prisma.aiDataset.create({
        data: {
          userId: b.ownerId,
          name: `${PREFIX} dataset`,
          caseCount: 1,
          contentHash: hashDatasetCases(evalCases),
          source: 'manual',
          cases: { create: evalCases.map((c) => ({ position: c.position, input: c.input })) },
        },
      });
      const run = await prisma.aiEvaluationRun.create({
        data: {
          userId: b.ownerId,
          name: `${PREFIX} run`,
          subjectKind: 'agent',
          agentId: idOf(subjectSlug),
          datasetId: dataset.id,
          datasetContentHash: dataset.contentHash,
          metricConfigs: [{ slug: 'judge_agent', config: { agentSlug: judgeSlug } }],
          status: 'queued',
          progress: { casesTotal: 1, casesDone: 0, casesFailed: 0 },
        },
      });
      return run.id;
    });
    const drained = await runAsOrg(b.orgId, () => processPendingEvaluationRuns());
    const caseResults = await runAsSystem('smoke: eval case results', () =>
      prisma.aiEvaluationCaseResult.findMany({
        where: { runId: evalRunId },
        select: { orgId: true, metricScores: true, errorCode: true },
      })
    );
    // `metricScores` is JSON, keyed by the judge's slug for `judge_agent`; read
    // the one number without asserting a shape on the rest.
    const scoreOf = (scores: unknown): unknown => {
      if (typeof scores !== 'object' || scores === null) return undefined;
      const entry: unknown = Reflect.get(scores, judgeSlug);
      return typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'score') : undefined;
    };
    const judgeScore = scoreOf(caseResults[0]?.metricScores);
    check(
      drained.completed === 1 && caseResults.length === 1 && caseResults[0].errorCode === null,
      `the worker completed B's run (completed ${drained.completed}, ${caseResults.length} result)`
    );
    check(judgeScore === JUDGE_SCORE, `B's ${judgeSlug} scored the case (${String(judgeScore)})`);

    // Every row those paths produced carries B — and none names A's agents.
    await new Promise((r) => setTimeout(r, 1000));
    const bIds = inB.map((r) => r.id);
    const aIds = inA.map((r) => r.id);
    const produced = await runAsSystem('smoke: rows the platform agents produced', async () => ({
      conversations: await prisma.aiConversation.findMany({
        where: { agentId: { in: [...bIds, ...aIds] } },
        select: { agentId: true, orgId: true },
      }),
      costLogs: await prisma.aiCostLog.findMany({
        where: { agentId: { in: [...bIds, ...aIds] } },
        select: { agentId: true, orgId: true },
      }),
    }));
    const convAgents = new Set(produced.conversations.map((c) => c.agentId));
    check(
      ['cleanup-agent', 'eval-case-generator', subjectSlug, judgeSlug].every((slug) =>
        convAgents.has(idOf(slug))
      ),
      `conversations exist for B's clean-up, generator, subject and judge (${produced.conversations.length})`
    );
    check(
      produced.costLogs.length > 0,
      `the model calls were costed (${produced.costLogs.length} cost rows)`
    );
    check(
      [...produced.conversations, ...produced.costLogs].every(
        (row) => row.orgId === b.orgId && row.agentId !== null && bIds.includes(row.agentId)
      ),
      'every conversation and cost row names one of B’s agents and carries B — none is A’s'
    );
    check(
      caseResults.every((r) => r.orgId === b.orgId),
      'the evaluation case result carries B'
    );

    // ── The patterns knowledge: the install org's (§116 t-726, t-733) ─────
    console.log(
      '\n[12] patterns knowledge: the install org’s alone; a copy loaded elsewhere stays there'
    );
    const patterns = await loadPatternsChunks();
    const copyIn = (orgId: string) =>
      runAsOrg(orgId, () =>
        prisma.aiKnowledgeDocument.findMany({
          where: { scope: 'system' },
          select: {
            id: true,
            slug: true,
            orgId: true,
            knowledgeBaseId: true,
            tags: { select: { orgId: true, tag: { select: { slug: true } } } },
          },
        })
      );
    check(
      (await copyIn(b.orgId)).length === 0 && (await copyIn(a.orgId)).length === 0,
      'an org made by createOrg holds no copy of the patterns document'
    );
    const installCopies = await copyIn(INSTALL_ORG_ID);
    check(
      installCopies.length === 1 &&
        installCopies[0].slug === PATTERNS_DOCUMENT_SLUG &&
        installCopies[0].orgId === INSTALL_ORG_ID,
      `the install org holds its copy (${installCopies.length})`
    );

    // Loaded by hand (the knowledge page's Load button runs the same write):
    // the copy lands in the loading org, keyed as every other org's is.
    await runAsOrg(b.orgId, () => materialisePatternsKnowledge(patterns));
    await runAsOrg(a.orgId, () => materialisePatternsKnowledge(patterns));
    const copyB = (await copyIn(b.orgId))[0];
    const copyA = (await copyIn(a.orgId))[0];
    check(
      copyB?.slug === PATTERNS_DOCUMENT_SLUG && copyB.orgId === b.orgId,
      'a copy loaded in B is B’s own'
    );
    check(copyB?.knowledgeBaseId === b.kbId, 'in B’s own default knowledge base');
    check(
      copyB?.tags.some((t) => t.tag.slug === PATTERNS_TAG_SLUG && t.orgId === b.orgId) === true,
      'tagged in B'
    );
    check(
      copyA !== undefined && copyA.id !== copyB?.id && copyA.orgId === a.orgId,
      'A’s copy is A’s own — not B’s row'
    );
    const chunksB = await runAsSystem('smoke: B’s patterns chunks', () =>
      prisma.aiKnowledgeChunk.findMany({
        where: { documentId: copyB?.id ?? 'missing' },
        select: { orgId: true },
      })
    );
    check(
      chunksB.length === patterns.length && chunksB.every((c) => c.orgId === b.orgId),
      `B's copy has all ${patterns.length} chunks, each carrying B (${chunksB.length})`
    );
    const sameKey = await runAsSystem('smoke: one patterns chunk key', () =>
      prisma.aiKnowledgeChunk.findMany({
        where: { chunkKey: patterns[0].id },
        select: { orgId: true },
      })
    );
    const keyOrgs = new Set(sameKey.map((c) => c.orgId));
    check(
      [INSTALL_ORG_ID, a.orgId, b.orgId].every((orgId) => keyOrgs.has(orgId)) &&
        keyOrgs.size === sameKey.length,
      `the chunk key \`${patterns[0].id}\` is held once in each of ${keyOrgs.size} orgs (unique per org)`
    );

    // The embed path, run in B: B's copy, and nobody else's.
    const unembedded = async (orgId: string): Promise<number> => {
      const rows = await runAsOrg(
        orgId,
        () =>
          prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM ai_knowledge_chunk WHERE embedding IS NULL`
      );
      return rows[0]?.n ?? -1;
    };
    const pendingB = await unembedded(b.orgId);
    const pendingA = await unembedded(a.orgId);
    const pendingInstall = await unembedded(INSTALL_ORG_ID);
    const patternsEmbedB = await runAsOrg(b.orgId, () => embedChunks());
    check(
      pendingB === patterns.length && patternsEmbedB.processed === pendingB,
      `B's embed run embedded B's ${pendingB} unembedded chunks (${patternsEmbedB.processed})`
    );
    check(
      (await unembedded(b.orgId)) === 0 &&
        pendingA >= patterns.length &&
        (await unembedded(a.orgId)) === pendingA &&
        (await unembedded(INSTALL_ORG_ID)) === pendingInstall,
      `and none of A's (${pendingA}) or the install org's (${pendingInstall})` +
        // On a fresh database the install org's copy is unembedded; a rerun
        // may find it embedded, which leaves that half nothing to catch.
        (pendingInstall < patterns.length ? ' — install half vacuous: its copy is embedded' : '')
    );

    // B searches, with A's identical copy embedded beside B's, so the policy
    // is all that keeps A's chunks out. The fake embedding keys on a text's
    // opening, so a query opening like a chunk scores 1 against it.
    await runAsOrg(a.orgId, () => embedChunks());
    const query = patterns[0].content.slice(0, 200);
    /** Two checks on chunks `who` read: some, and every one from B's own copy. */
    const onlyBsCopy = async (who: string, ids: string[], ok = true): Promise<void> => {
      const read = await runAsSystem(`smoke: chunks ${who} read`, () =>
        prisma.aiKnowledgeChunk.findMany({
          where: { id: { in: ids } },
          select: { orgId: true, documentId: true },
        })
      );
      check(
        ok && ids.length > 0 && read.length === ids.length,
        `${who} retrieved ${ids.length} chunks`
      );
      check(
        read.every((c) => c.orgId === b.orgId && c.documentId === copyB?.id),
        `every chunk ${who} read is from B’s own copy and carries B — none is A’s`
      );
    };
    const found = await runAsOrg(b.orgId, () => searchKnowledge(query, undefined, 10, 1));
    await onlyBsCopy(
      'B’s search',
      found.map((r) => r.chunk.id)
    );

    // Through an agent in restricted mode: B's own agent, granted the patterns
    // tag. Its access resolves the tag to documents in B (checked directly:
    // the search below would pass system-scope documents through either way),
    // and `search_knowledge_base` runs the way the advisor's did.
    const patternsTag = await prisma.knowledgeTag.findUnique({
      where: { slug: PATTERNS_TAG_SLUG },
      select: { id: true },
    });
    if (!patternsTag) throw new Error('the patterns tag is missing — run the seed');
    const searchCapability = await prisma.aiCapability.findUnique({
      where: { slug: 'search_knowledge_base' },
      select: { id: true },
    });
    if (!searchCapability) throw new Error('search_knowledge_base is not seeded — run the seed');
    await runAsOrg(b.orgId, async () => {
      await prisma.aiAgent.update({
        where: { id: b.agentId },
        data: { knowledgeAccessMode: 'restricted' },
      });
      await prisma.aiAgentKnowledgeTag.create({
        data: { agentId: b.agentId, tagId: patternsTag.id },
      });
      // Bound, as the advisor was, so this passes under
      // CAPABILITY_BINDING_MODE=strict too.
      // (The fixture may already hold it: its one binding is whichever
      // capability comes first.)
      await prisma.aiAgentCapability.upsert({
        where: {
          agentId_capabilityId: { agentId: b.agentId, capabilityId: searchCapability.id },
        },
        create: { agentId: b.agentId, capabilityId: searchCapability.id, isEnabled: true },
        update: { isEnabled: true },
      });
    });
    invalidateAgentAccess(b.agentId);
    const access = await runAsOrg(b.orgId, () => resolveAgentDocumentAccess(b.agentId));
    check(
      access.mode === 'restricted' &&
        copyB !== undefined &&
        access.documentIds.includes(copyB.id) &&
        !access.documentIds.includes(copyA?.id ?? 'none'),
      'the tag grant resolves, in B, to B’s copy and not A’s'
    );
    registerBuiltInCapabilities();
    const toolSearch = await runAsOrg(b.orgId, () =>
      capabilityDispatcher.dispatch(
        'search_knowledge_base',
        { query },
        {
          userId: b.ownerId,
          agentId: b.agentId,
        }
      )
    );
    const toolFound = z
      .object({ results: z.array(z.object({ chunkId: z.string() })) })
      .safeParse(toolSearch.data);
    await onlyBsCopy(
      `B’s restricted agent’s search_knowledge_base${toolSearch.success ? '' : ` (${toolSearch.error?.message ?? 'failed'})`}`,
      toolFound.success ? toolFound.data.results.map((r) => r.chunkId) : [],
      toolSearch.success
    );

    // ── The built-in workflow templates: served from code (§116 t-727) ────
    console.log('\n[13] workflow templates: every org has the built-ins; its own stay its own');
    const builtinSlugs = BUILTIN_WORKFLOW_TEMPLATES.map((t) => t.slug);
    const catalogueIn = async (orgId: string) =>
      (await runAsOrg(orgId, () => listWorkflowTemplates())).templates;
    const customTemplateSlug = `${PREFIX}-tpl-a-${stamp}`;
    await runAsOrg(a.orgId, () =>
      prisma.aiWorkflow.create({
        data: {
          name: `${PREFIX} template a`,
          slug: customTemplateSlug,
          description: 'smoke fixture',
          isTemplate: true,
          templateSource: 'custom',
        },
      })
    );
    const catalogueB = await catalogueIn(b.orgId);
    const catalogueA = await catalogueIn(a.orgId);
    const builtinsB = catalogueB.filter((e) => e.source === 'builtin');
    check(
      builtinsB.map((e) => e.slug).join() === builtinSlugs.join() &&
        builtinsB.every((e) => e.source === 'builtin' && e.workflowDefinition.steps.length > 0),
      `B, made by createOrg, lists all ${builtinSlugs.length} built-ins with their definitions (${builtinsB.length})`
    );
    check(
      catalogueA.some((e) => e.source === 'custom' && e.slug === customTemplateSlug),
      'A lists its own custom template'
    );
    check(
      !catalogueB.some((e) => e.slug === customTemplateSlug),
      'B does not list A’s custom template'
    );
    // "Use template" loads the definition onto the canvas; saving it makes
    // the writes the create route makes (the row, then its v1 through
    // `createInitialVersion`, in one transaction), here through Prisma
    // directly rather than the route.
    const picked = builtinsB[0];
    const fromTemplateSlug = `${PREFIX}-from-tpl-b-${stamp}`;
    const fromTemplate = await runAsOrg(b.orgId, () =>
      prisma.$transaction(async (tx) => {
        const created = await tx.aiWorkflow.create({
          data: {
            name: picked.name,
            slug: fromTemplateSlug,
            description: picked.description,
            patternsUsed: picked.patternsUsed,
            createdBy: b.ownerId,
          },
        });
        const version = await createInitialVersion({
          tx,
          workflowId: created.id,
          definition: picked.workflowDefinition,
          userId: b.ownerId,
        });
        return { workflow: created, version };
      })
    );
    const versionRow = await runAsOrg(b.orgId, () =>
      prisma.aiWorkflowVersion.findUnique({
        where: { id: fromTemplate.version.id },
        select: { orgId: true },
      })
    );
    check(
      fromTemplate.workflow.orgId === b.orgId && versionRow?.orgId === b.orgId,
      `a workflow B creates from ${picked.slug} is B’s, and so is its version`
    );
    const seenFromA = await runAsOrg(a.orgId, () =>
      prisma.aiWorkflow.findMany({ where: { slug: fromTemplateSlug }, select: { id: true } })
    );
    check(seenFromA.length === 0, 'A cannot see it');

    // ── [14] A workflow slug another org holds (§107 t-728) ───────────────
    // `AiWorkflow.slug` is unique across the install, and the policy hides
    // A's workflows from B, so a plain read in B calls A's slug free.
    console.log('\n[14] workflow slugs: B is told the truth about a slug only A holds');
    const heldByA = `${b.workflowSlug}-template`;
    await runAsOrg(a.orgId, () =>
      prisma.aiWorkflow.create({
        data: { name: `${PREFIX} slug held by a`, slug: heldByA, description: 'smoke fixture' },
      })
    );
    const plainReadInB = await runAsOrg(b.orgId, () =>
      prisma.aiWorkflow.findUnique({ where: { slug: heldByA }, select: { id: true } })
    );
    check(
      plainReadInB === null,
      'a plain read in B cannot see A’s slug (the case the fix exists for)'
    );
    // What save-as-template did before t-728: trust that read, and create.
    await rejects(
      () =>
        runAsOrg(b.orgId, () =>
          prisma.aiWorkflow.create({
            data: { name: `${PREFIX} collides`, slug: heldByA, description: 'smoke fixture' },
          })
        ),
      /Unique constraint/,
      'so B creating on the slug that read called free fails on the unique index'
    );
    check(
      await runAsOrg(b.orgId, () => isWorkflowSlugTaken(heldByA)),
      'isWorkflowSlugTaken, asked from B, says A’s slug is taken'
    );
    const freeForB = await runAsOrg(b.orgId, () => findFreeWorkflowSlug(heldByA));
    check(freeForB === `${heldByA}-1`, `B is given a slug no org holds (${freeForB})`);
    let createdInB = false;
    try {
      await runAsOrg(b.orgId, () =>
        prisma.aiWorkflow.create({
          data: { name: `${PREFIX} template b`, slug: freeForB, description: 'smoke fixture' },
        })
      );
      createdInB = true;
    } catch (err) {
      console.log(`    create failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    check(createdInB, 'B creates its workflow on that slug without a unique-index failure');

    // ── [15] Global config in use by another org (§107 t-731) ────────────
    // Providers, models, tags and profiles are global; what uses them is
    // tenant-owned. A count in A's scope misses B's agent, so A could delete
    // what B depends on. The checks count every org and name only A's rows.
    console.log('\n[15] global config: B’s usage counts in A’s delete checks, unnamed');
    const sharedProvider = `${PREFIX}-shared-provider-${stamp}`;
    const sharedModel = `${PREFIX}-shared-model-${stamp}`;
    const profile = await prisma.aiAgentProfile.create({
      data: { name: `${PREFIX} shared profile`, slug: `${PREFIX}-profile-${stamp}` },
    });
    const sharedTag = await prisma.knowledgeTag.create({
      data: { slug: `${PREFIX}-shared-tag-${stamp}`, name: `${PREFIX} shared tag` },
    });
    const userOfShared = await runAsOrg(b.orgId, async () => {
      const agent = await prisma.aiAgent.create({
        data: {
          name: `${PREFIX} uses shared config`,
          slug: `${PREFIX}-uses-shared-${stamp}`,
          description: 'smoke fixture',
          systemInstructions: 'smoke fixture',
          provider: sharedProvider,
          model: sharedModel,
          profileId: profile.id,
        },
      });
      await prisma.aiAgentKnowledgeTag.create({ data: { agentId: agent.id, tagId: sharedTag.id } });
      return agent;
    });
    const plainCountInA = await runAsOrg(a.orgId, () =>
      prisma.aiAgent.count({ where: { provider: sharedProvider } })
    );
    check(
      plainCountInA === 0,
      'a plain count in A cannot see B’s agent (the case the fix exists for)'
    );
    const asA = <T>(fn: () => Promise<T>) => runAsOrg(a.orgId, fn, { source: 'session' });
    const providerSeen = await asA(() => providerUsage(sharedProvider));
    check(
      providerSeen.primaryAgents === 1,
      `providerUsage, asked from A, counts B’s agent (${providerSeen.primaryAgents}), so the permanent delete is refused`
    );
    const modelSeen = await asA(() => providerModelUsage(sharedProvider, sharedModel));
    check(
      modelSeen.otherOrgAgents === 1 && modelSeen.agents.length === 0,
      `providerModelUsage, asked from A, counts B’s agent and names none of B’s rows (${JSON.stringify(modelSeen)})`
    );
    const modelSeenByB = await runAsOrg(b.orgId, () =>
      providerModelUsage(sharedProvider, sharedModel)
    );
    check(
      modelSeenByB.agents.map((r) => r.id).join() === userOfShared.id &&
        modelSeenByB.otherOrgAgents === 0,
      'asked from B, the same check names B’s own agent'
    );
    const tagSeen = await asA(() => knowledgeTagUsage(sharedTag.id));
    check(
      tagSeen.agentGrants === 1 && tagSeen.otherOrgAgentGrants === 1 && tagSeen.agents.length === 0,
      `knowledgeTagUsage, asked from A, counts B’s grant and names none of B’s rows (${JSON.stringify(tagSeen)})`
    );
    // The fixture tag is on one document in each org: A's delete check and
    // the tag list count both, and the check says one is another org's.
    const fixtureTagSeen = await asA(() => knowledgeTagUsage(tag.id));
    check(
      fixtureTagSeen.documentLinks === 2 && fixtureTagSeen.otherOrgDocumentLinks === 1,
      `knowledgeTagUsage, asked from A, counts both orgs’ documents and says one is B’s (${fixtureTagSeen.documentLinks}/${fixtureTagSeen.otherOrgDocumentLinks})`
    );
    const listCounts = await asA(() => knowledgeTagCounts([tag.id, sharedTag.id]));
    check(
      listCounts.get(tag.id)?.documents === 2 && listCounts.get(sharedTag.id)?.agents === 1,
      `knowledgeTagCounts, asked from A, counts every org for the tag list (${JSON.stringify([...listCounts])})`
    );
    const profileSeen = await asA(() => agentProfileUsage([profile.id]));
    check(
      profileSeen.get(profile.id) === 1,
      `agentProfileUsage, asked from A, counts B’s attached agent (${profileSeen.get(profile.id) ?? 0})`
    );

    // The read surfaces (§107 t-752): the models matrix, a provider's model
    // list and the capabilities pages count every org, naming only the
    // caller's agents.
    const matrixFromA = await asA(() => modelAgentUsage([sharedProvider], [sharedModel]));
    const matrixRow = matrixFromA.get(modelUsageKey(sharedProvider, sharedModel));
    check(
      matrixRow?.agents.length === 0 && matrixRow.otherOrgAgents === 1,
      `modelAgentUsage, asked from A, counts B’s agent on the model and names none (${JSON.stringify(matrixRow)})`
    );
    const providerFromB = await runAsOrg(b.orgId, () => modelAgentUsage([sharedProvider]));
    check(
      providerFromB.get(modelUsageKey(sharedProvider, sharedModel))?.agents[0]?.id ===
        userOfShared.id,
      'asked from B for the whole provider, the same read names B’s own agent'
    );
    const capabilityFromA = (await asA(() => capabilityAgentUsage([capability.id]))).get(
      capability.id
    );
    const namedFromA = capabilityFromA?.agents.map((x) => x.id) ?? [];
    check(
      namedFromA.includes(a.agentId) &&
        !namedFromA.includes(b.agentId) &&
        (capabilityFromA?.otherOrgAgents ?? 0) >= 1,
      `capabilityAgentUsage, asked from A, names A’s agent, not B’s, and counts B’s (${namedFromA.length} named, ${capabilityFromA?.otherOrgAgents ?? 0} elsewhere)`
    );
    // The workflow-pin prefilter is JSON containment, which only Postgres
    // can answer: a draft pin in B and a published pin in A must both match.
    const pinning = (model: string) => ({
      steps: [
        {
          id: 'llm-1',
          name: 'LLM',
          type: 'llm_call',
          config: { prompt: 'smoke', modelOverride: model },
          nextSteps: [],
        },
      ],
      entryStepId: 'llm-1',
      errorStrategy: 'fail',
    });
    await runAsOrg(b.orgId, () =>
      prisma.aiWorkflow.create({
        data: {
          name: `${PREFIX} pins the model (draft)`,
          slug: `${PREFIX}-pin-draft-${stamp}`,
          description: 'smoke fixture',
          draftDefinition: pinning(sharedModel),
        },
      })
    );
    await runAsOrg(a.orgId, async () => {
      const pinned = await prisma.aiWorkflow.create({
        data: {
          name: `${PREFIX} pins the model (published)`,
          slug: `${PREFIX}-pin-published-${stamp}`,
          description: 'smoke fixture',
          versions: { create: { version: 1, snapshot: pinning(sharedModel) } },
        },
        include: { versions: true },
      });
      await prisma.aiWorkflow.update({
        where: { id: pinned.id },
        data: { publishedVersionId: pinned.versions[0].id },
      });
    });
    const pinsSeen = await asA(() => providerModelUsage(sharedProvider, sharedModel));
    check(
      pinsSeen.workflows.length === 1 && pinsSeen.otherOrgWorkflows === 1,
      `providerModelUsage's JSON prefilter finds A’s published pin (named) and B’s draft pin (counted) (${pinsSeen.workflows.length}/${pinsSeen.otherOrgWorkflows})`
    );

    // ── [16] Shared settings: changed only from the install org ──────────
    // Any org's workflow reaches these through a `tool_call` step, which
    // dispatches as `workflow:<id>` and skips the agent binding (§107 t-751).
    console.log(
      '\n[16] shared settings: refused from B and from nowhere, written from the install org, a system scope and an admin key'
    );
    registerBuiltInCapabilities();
    const smokeModelSlug = `${PREFIX}-model-${stamp}`;
    const newModel = {
      name: `${PREFIX} model`,
      slug: smokeModelSlug,
      providerSlug: `${PREFIX}-provider-${stamp}`,
      modelId: `${PREFIX}-model-${stamp}`,
      description: 'smoke fixture',
      capabilities: ['chat'],
      tierRole: 'worker',
      deploymentProfiles: ['hosted'],
      bestRole: 'smoke fixture',
      reasoningDepth: 'medium',
      latency: 'fast',
      costEfficiency: 'high',
      contextLength: 'medium',
      toolUse: 'moderate',
    };
    const asWorkflowIn = (orgId: string, slug: string, args: Record<string, unknown>) =>
      runAsOrg(
        orgId,
        () =>
          capabilityDispatcher.dispatch(slug, args, {
            userId: b.ownerId,
            agentId: `workflow:${b.workflowId}`,
          }),
        { source: 'job' }
      );
    const modelRow = () =>
      runAsSystem('smoke: read the shared model', () =>
        prisma.aiProviderModel.findUnique({
          where: { slug: smokeModelSlug },
          select: { id: true, isActive: true, costEfficiency: true },
        })
      );
    const refusedCode = (r: { success: boolean; error?: { code: string } }) =>
      !r.success && r.error?.code === 'shared_settings_install_org_only';

    const addFromB = await asWorkflowIn(b.orgId, 'add_provider_models', { newModels: [newModel] });
    check(
      refusedCode(addFromB) && (await modelRow()) === null,
      `add_provider_models, dispatched by B’s workflow, is refused and creates nothing (${JSON.stringify(addFromB.error ?? addFromB.data)})`
    );
    const addFromInstall = await asWorkflowIn(INSTALL_ORG_ID, 'add_provider_models', {
      newModels: [newModel],
    });
    const created = await modelRow();
    check(
      addFromInstall.success && created !== null,
      `add_provider_models from the install org creates the model (${JSON.stringify(addFromInstall.error ?? addFromInstall.data)})`
    );
    if (created) {
      const auditFromB = await asWorkflowIn(b.orgId, 'apply_audit_changes', {
        model_id: created.id,
        changes: [
          {
            field: 'costEfficiency',
            currentValue: 'high',
            proposedValue: 'medium',
            reason: 'smoke fixture',
            confidence: 'high',
          },
        ],
      });
      const deactivateFromB = await asWorkflowIn(b.orgId, 'deactivate_provider_models', {
        deactivateModels: [{ modelId: created.id, reason: 'smoke fixture' }],
      });
      const afterB = await modelRow();
      check(
        refusedCode(auditFromB) &&
          refusedCode(deactivateFromB) &&
          afterB?.isActive === true &&
          afterB.costEfficiency === 'high',
        `apply_audit_changes and deactivate_provider_models, dispatched by B’s workflow, are refused and change nothing (${JSON.stringify([auditFromB.error, deactivateFromB.error, afterB])})`
      );
      // Nobody entered an org: a bug state, not a credential, so refused too.
      const deactivateFromNowhere = await capabilityDispatcher.dispatch(
        'deactivate_provider_models',
        { deactivateModels: [{ modelId: created.id, reason: 'smoke fixture' }] },
        { userId: a.ownerId, agentId: `workflow:${b.workflowId}` }
      );
      check(
        refusedCode(deactivateFromNowhere) && (await modelRow())?.isActive === true,
        'deactivate_provider_models with no org entered is refused and changes nothing'
      );
      const deactivateAsSystem = await runAsSystem('smoke: the platform deactivates a model', () =>
        capabilityDispatcher.dispatch(
          'deactivate_provider_models',
          { deactivateModels: [{ modelId: created.id, reason: 'smoke fixture' }] },
          { userId: a.ownerId, agentId: `workflow:${b.workflowId}` }
        )
      );
      check(
        deactivateAsSystem.success && (await modelRow())?.isActive === false,
        `deactivate_provider_models in a system scope deactivates it (${JSON.stringify(deactivateAsSystem.error ?? deactivateAsSystem.data)})`
      );
    }

    // The guard with the option, called with an unbound admin API key: no
    // org is entered, and it lets the write through (ruling, 2026-10-02).
    // The key is resolved from the database; the handler is `createFlag`
    // itself, because the feature-flags route's own logger reads Next's
    // request headers, which exist only inside a request.
    const rawAdminKey = `sk_${PREFIX}_${stamp}_${'a'.repeat(40)}`;
    await runAsSystem('smoke: mint an unbound admin key', () =>
      prisma.aiApiKey.create({
        data: {
          userId: a.ownerId,
          name: `${PREFIX} admin key`,
          keyHash: hashApiKey(rawAdminKey),
          keyPrefix: rawAdminKey.slice(0, 8),
          scopes: ['admin'],
          orgId: null,
        },
      })
    );
    const smokeFlag = `SMOKE_ISO_${stamp}`;
    const flagResponse = await withAdminAuth(
      async () => {
        await createFlag({ name: smokeFlag, enabled: false });
        return Response.json({ success: true }, { status: 201 });
      },
      { writesSharedSettings: true }
    )(
      new NextRequest('http://localhost:3000/api/v1/admin/feature-flags', {
        method: 'POST',
        headers: { authorization: `Bearer ${rawAdminKey}` },
      })
    );
    const flagRow = await prisma.featureFlag.findUnique({ where: { name: smokeFlag } });
    check(
      flagResponse.status === 201 && flagRow !== null,
      `a write declaring writesSharedSettings, with an unbound admin key, from no org, creates the flag (${flagResponse.status})`
    );

    const rowIds = (rows: unknown[] | undefined): string[] =>
      (rows ?? []).flatMap((r) =>
        typeof r === 'object' && r !== null && 'id' in r && typeof r.id === 'string' ? [r.id] : []
      );
    /** How each section's run is entered: a session in A, and an admin API key (no org). */
    const askers = [
      ['from inside A', <T>(fn: () => Promise<T>) => runAsOrg(a.orgId, fn, { source: 'session' })],
      ['from no org (an admin API key)', <T>(fn: () => Promise<T>) => fn()],
    ] as const;

    // ── [17] A person's export: their rows in every org (§107 t-748) ──────
    // A person belongs to A and B, with a conversation and a memory in each.
    // The self-service route runs in their session's active org, and an admin
    // API key enters none; either way the bundle must hold both orgs' rows.
    console.log(
      '\n[17] a person in A and B: their export holds both orgs’ rows, and no one else’s'
    );
    const seedPerson = async (label: string) => {
      const user = await prisma.user.create({
        data: {
          name: `${PREFIX} person ${label}`,
          email: `${PREFIX}-person-${label}-${stamp}@example.com`,
        },
      });
      const rows: Array<{ orgId: string; ids: string[] }> = [];
      for (const f of [a, b]) {
        await prisma.orgMembership.create({
          data: { orgId: f.orgId, userId: user.id, role: 'MEMBER' },
        });
        const ids = await runAsOrg(f.orgId, async () => {
          const conversation = await prisma.aiConversation.create({
            data: {
              agentId: f.agentId,
              userId: user.id,
              title: `${PREFIX} ${label}’s conversation`,
              messages: { create: [{ role: 'user', content: `${label} asks about ${f.topic}` }] },
            },
            include: { messages: true },
          });
          const memory = await prisma.aiUserMemory.create({
            data: {
              userId: user.id,
              agentId: f.agentId,
              key: `${PREFIX}-fact`,
              value: `${label} works in ${f.topic}`,
            },
          });
          return [conversation.id, ...conversation.messages.map((m) => m.id), memory.id];
        });
        rows.push({ orgId: f.orgId, ids });
      }
      return { userId: user.id, email: user.email, rows };
    };
    const person = await seedPerson('one');
    const personIds = person.rows.flatMap((r) => r.ids);
    // The owners' conversations sit in the same orgs, under the same agents.
    const otherIds = new Set([
      a.conversationId,
      ...a.messageIds,
      b.conversationId,
      ...b.messageIds,
    ]);
    for (const [label, run] of askers) {
      let bundle: Awaited<ReturnType<typeof exportUserData>> | null = null;
      try {
        bundle = await run(() =>
          exportUserData({
            userId: person.userId,
            actorUserId: person.userId,
            reason: 'self_service',
          })
        );
      } catch (err) {
        check(
          false,
          `the person’s export ${label} — it threw: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      const conversations = bundle.personalData.conversations ?? [];
      const held = [
        ...rowIds(conversations),
        ...conversations.flatMap((c) =>
          typeof c === 'object' && c !== null && 'messages' in c && Array.isArray(c.messages)
            ? rowIds(c.messages)
            : []
        ),
        ...rowIds(bundle.personalData.agentMemory),
      ];
      const missing = person.rows.filter((r) => !r.ids.every((id) => held.includes(id)));
      check(
        missing.length === 0,
        `the person’s export ${label} holds their conversation, message and memory in both orgs${missing.length ? ` — missing the rows in: ${missing.map((r) => r.orgId).join(', ')}` : ''}`
      );
      const foreign = held.filter((id) => otherIds.has(id) || !personIds.includes(id));
      check(foreign.length === 0, `the person’s export ${label} holds no one else’s rows`);
    }

    // ── [18] A person's erasure: their rows in every org (§107 t-748) ─────
    // Asked from inside A, and from no org. The cascades are FK actions, which
    // RLS does not filter, so both orgs' rows should go either way.
    console.log(
      '\n[18] a person in A and B: erased from inside A, and from no org, leaves no row in either'
    );
    const personRowsByOrg = (userId: string) =>
      runAsSystem('smoke: a person’s rows in every org', async () => {
        const rows = [
          ...(await prisma.aiConversation.findMany({ where: { userId }, select: { orgId: true } })),
          ...(await prisma.aiUserMemory.findMany({ where: { userId }, select: { orgId: true } })),
        ];
        return [a.orgId, b.orgId].map((orgId) => rows.filter((r) => r.orgId === orgId).length);
      });
    const people = [person, await seedPerson('two')];
    for (const [i, [label, run]] of askers.entries()) {
      const who = people[i];
      const before = await personRowsByOrg(who.userId);
      check(
        before.every((n) => n === 2),
        `person ${i + 1} holds a conversation and a memory in A and in B before erasure (${before.join(', ')})`
      );
      try {
        await run(() =>
          eraseUser({
            userId: who.userId,
            userEmail: who.email,
            actorUserId: a.ownerId,
            reason: 'admin_action',
          })
        );
      } catch (err) {
        check(
          false,
          `person ${i + 1}’s erasure ${label} — it threw: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      const after = await personRowsByOrg(who.userId);
      const account = await prisma.user.findUnique({ where: { id: who.userId } });
      check(
        account === null && after.every((n) => n === 0),
        `person ${i + 1}, erased ${label}, is gone, with no conversation or memory left in A or B (${after.join(', ')})`
      );
    }
    const ownersLeft = await runAsSystem('smoke: the owners’ conversations', () =>
      prisma.aiConversation.count({ where: { id: { in: [a.conversationId, b.conversationId] } } })
    );
    check(
      ownersLeft === 2,
      `the owners’ conversations in A and B are untouched (${ownersLeft} of 2)`
    );

    // ── [19] Org export: the target org's rows, whoever is asking ─────────
    // A platform admin exports from inside their own active org (the session
    // guard enters it), and an admin API key enters none (§106 t-735).
    console.log('\n[19] org export: B’s bundle, asked from inside A and from no org at all');
    for (const [label, run] of askers) {
      let bundle: Awaited<ReturnType<typeof exportOrgData>> | null = null;
      try {
        bundle = await run(() => exportOrgData({ orgId: b.orgId, actorUserId: a.ownerId }));
      } catch (err) {
        check(
          false,
          `B’s export ${label} — it threw: ${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }
      const sections: Array<[string, string[]]> = [
        ['agents', [b.agentId]],
        ['knowledgeBases', [b.kbId]],
        ['knowledgeDocuments', [b.documentId]],
        ['knowledgeChunks', b.chunkIds],
        ['conversations', [b.conversationId]],
        ['messages', b.messageIds],
        ['workflows', [b.workflowId]],
      ];
      const missing = sections.filter(
        ([section, ids]) => !ids.every((id) => rowIds(bundle.data[section]).includes(id))
      );
      check(
        missing.length === 0,
        `B’s export ${label} holds B’s rows${missing.length ? ` — missing: ${missing.map(([s]) => s).join(', ')}` : ''}`
      );
      const aIds = new Set([
        a.agentId,
        a.kbId,
        a.documentId,
        ...a.chunkIds,
        a.conversationId,
        ...a.messageIds,
        a.workflowId,
        a.executionId,
        a.costLogId,
      ]);
      const leaked = Object.values(bundle.data).flatMap((rows) =>
        rowIds(rows).filter((id) => aIds.has(id))
      );
      check(leaked.length === 0, `B’s export ${label} holds none of A’s`);
    }

    // ── [20] Org erasure: from inside another org, with knowledge documents ─
    // `ai_knowledge_document.knowledgeBaseId` is ON DELETE RESTRICT, and both
    // rows also cascade from the org: erasure must still go through (t-730).
    console.log('\n[20] org erasure: B, holding documents and chunks, erased from inside A');
    // Every tenant-owned table, counted by the org's id, as the bypass. A
    // `SetNull` relation (`AiCostLog`, a billing record) keeps its row with the
    // org detached, so "no row carries the org" is the claim, not "no row".
    const tenantTables = [...tenantOwnedModels(prisma).values()];
    const tenantRowsOf = (orgId: string) =>
      runAsSystem('smoke: count an org’s rows', async () => {
        const counts: Record<string, number> = {};
        for (const table of tenantTables) {
          const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
            `SELECT count(*) AS n FROM "${table}" WHERE "orgId" = $1`,
            orgId
          );
          counts[table] = Number(row.n);
        }
        return counts;
      });
    const nonZero = (counts: Record<string, number>) =>
      Object.entries(counts).filter(([, n]) => n > 0);
    const beforeB = await tenantRowsOf(b.orgId);
    check(
      beforeB.ai_knowledge_document > 0 &&
        beforeB.ai_knowledge_chunk > 0 &&
        beforeB.ai_knowledge_base > 0,
      `B holds a knowledge base, documents and chunks before erasure (${beforeB.ai_knowledge_document} documents, ${beforeB.ai_knowledge_chunk} chunks)`
    );
    const beforeA = await tenantRowsOf(a.orgId);
    try {
      const erased = await runAsOrg(
        a.orgId,
        () => eraseOrg({ orgId: b.orgId, actorUserId: a.ownerId }),
        { source: 'session' }
      );
      check(erased.members === 1, `the erasure counts B’s one member (${erased.members})`);
    } catch (err) {
      check(
        false,
        `B’s erasure from inside A — it threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const afterB = await tenantRowsOf(b.orgId);
    const orgLeft = await prisma.org.findUnique({ where: { id: b.orgId }, select: { id: true } });
    check(
      orgLeft === null && nonZero(afterB).length === 0,
      `B is gone, and no row in any of the ${tenantTables.length} tenant-owned tables carries its org${nonZero(afterB).length ? ` — left: ${JSON.stringify(nonZero(afterB))}` : ''}`
    );
    const afterA = await tenantRowsOf(a.orgId);
    check(
      JSON.stringify(afterA) === JSON.stringify(beforeA),
      `A’s rows are untouched, in every tenant-owned table (${nonZero(afterA).length} hold some)`
    );
    // An admin API key enters no org: the same erasure, of A, from nowhere.
    try {
      await eraseOrg({ orgId: a.orgId, actorUserId: a.ownerId });
    } catch (err) {
      check(
        false,
        `A’s erasure from no org — it threw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const afterErasingA = await tenantRowsOf(a.orgId);
    check(
      (await prisma.org.findUnique({ where: { id: a.orgId }, select: { id: true } })) === null &&
        nonZero(afterErasingA).length === 0,
      `A, erased from no org (an admin API key), is gone, and no row carries its org${nonZero(afterErasingA).length ? ` — left: ${JSON.stringify(nonZero(afterErasingA))}` : ''}`
    );

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
      await prisma.aiAgentProfile.deleteMany({ where: { slug: { startsWith: `${PREFIX}-` } } });
      await prisma.aiProviderConfig.deleteMany({ where: { slug: { startsWith: `${PREFIX}-` } } });
      await prisma.aiProviderModel.deleteMany({ where: { slug: { startsWith: `${PREFIX}-` } } });
      await prisma.featureFlag.deleteMany({ where: { name: { startsWith: 'SMOKE_ISO_' } } });
      if (mcpExposureCapabilityId) {
        if (mcpExposure) {
          await prisma.mcpExposedTool.update({
            where: { capabilityId: mcpExposureCapabilityId },
            data: { isEnabled: mcpExposure.isEnabled },
          });
        } else {
          await prisma.mcpExposedTool.delete({
            where: { capabilityId: mcpExposureCapabilityId },
          });
        }
      }
    }).catch((err: unknown) => {
      // A failed cleanup fails the run (t-730): `org.deleteMany` here erases
      // whatever org [20] did not, and an org that could not be erased is a
      // finding, not housekeeping. Set rather than thrown, so a run that has
      // already failed keeps its own error as the one reported.
      console.error('✗ cleanup failed — remove the smoke-iso rows by hand', err);
      process.exitCode = 1;
    });
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\n✗ smoke:tenancy-isolation failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
