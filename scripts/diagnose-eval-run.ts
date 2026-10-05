/**
 * Diagnose why an evaluation run's tool-trajectory grader (e.g.
 * `tool_was_called`) is failing every case.
 *
 * Pulls the most recent `AiEvaluationRun` (or one by id via argv) and
 * answers the three questions that matter for a 0/N pass rate on a
 * `tool_was_called` metric:
 *
 *   1. Was the tool actually bound + enabled on the subject agent at
 *      claim time? (If not, the LLM was never offered it.)
 *   2. Does the model support tool-calling at all?
 *   3. Did the agent's persisted conversation messages contain any
 *      tool-role rows, and how do they compare to the per-case
 *      `subjectMetadata.toolCalls` the worker wrote?
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local tsx -r dotenv/config scripts/diagnose-eval-run.ts
 *   DOTENV_CONFIG_PATH=.env.local tsx -r dotenv/config scripts/diagnose-eval-run.ts <runId>
 *
 * (dotenv 18 reads the path from DOTENV_CONFIG_PATH only; the old
 * `dotenv_config_path=` argument is ignored.)
 *
 * Read-only — no writes. Safe to re-run.
 */

import { prisma } from '@/lib/db/client';

const TARGET_TOOL_SLUG = 'search_knowledge_base';

async function main(): Promise<void> {
  const explicitRunId = process.argv.find((a) => !a.startsWith('-') && a.includes('cm'));

  const run = explicitRunId
    ? await prisma.aiEvaluationRun.findUnique({ where: { id: explicitRunId } })
    : await prisma.aiEvaluationRun.findFirst({ orderBy: { createdAt: 'desc' } });
  if (!run) {
    console.log('No evaluation run found.');
    return;
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Run: ${run.name}  (${run.id})`);
  console.log(
    `  status=${run.status}  subjectKind=${run.subjectKind}  createdAt=${run.createdAt.toISOString()}`
  );
  console.log(`  metricConfigs:`, JSON.stringify(run.metricConfigs, null, 2));

  // ── 1. Subject agent introspection ─────────────────────────────────────
  if (run.subjectKind !== 'agent' || !run.agentId) {
    console.log('\n(Workflow subject — agent-binding checks not applicable.)');
  } else {
    const agent = await prisma.aiAgent.findUnique({
      where: { id: run.agentId },
      include: {
        capabilities: { include: { capability: true } },
      },
    });
    if (!agent) {
      console.log('\nSubject agent NOT FOUND.');
      return;
    }

    console.log('\n━ Subject agent ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  ${agent.name}  (slug=${agent.slug}, id=${agent.id})`);
    console.log(`  isActive=${agent.isActive}  isSystem=${agent.isSystem}`);
    console.log(`  model=${agent.model || '(empty — resolves at runtime)'}`);
    console.log(`  provider=${agent.provider || '(empty — resolves at runtime)'}`);
    console.log(`  knowledgeAccessMode=${agent.knowledgeAccessMode}`);
    console.log(`  systemInstructions (first 600 chars):`);
    console.log(
      '    ' + (agent.systemInstructions ?? '(none)').slice(0, 600).replace(/\n/g, '\n    ')
    );

    console.log('\n━ Capability bindings ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (agent.capabilities.length === 0) {
      console.log('  (none) — the LLM has NO tools to choose from.');
    } else {
      for (const link of agent.capabilities) {
        const flag = link.isEnabled ? '✓ enabled ' : '✗ disabled';
        console.log(`  ${flag}  ${link.capability.slug}  (${link.capability.name})`);
      }
      const target = agent.capabilities.find((l) => l.capability.slug === TARGET_TOOL_SLUG);
      if (!target) {
        console.log(`\n  ⚠ Target tool '${TARGET_TOOL_SLUG}' is NOT bound to this agent.`);
      } else if (!target.isEnabled) {
        console.log(`\n  ⚠ Target tool '${TARGET_TOOL_SLUG}' is bound but DISABLED.`);
      }
    }
  }

  // ── 2. Look at the first failing case ──────────────────────────────────
  const results = await prisma.aiEvaluationCaseResult.findMany({
    where: { runId: run.id },
    orderBy: { casePosition: 'asc' },
    include: { datasetCase: true },
    take: 3,
  });

  console.log('\n━ First 3 case results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const r of results) {
    console.log(`\n  Case #${r.casePosition}:`);
    const input = r.datasetCase?.input;
    const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    console.log(`    input: ${inputStr.slice(0, 200)}`);
    console.log(`    subjectOutput: ${(r.subjectOutput ?? '').slice(0, 200)}…`);
    const meta = (r.subjectMetadata ?? {}) as Record<string, unknown>;
    const toolCalls = Array.isArray(meta.toolCalls) ? (meta.toolCalls as unknown[]) : [];
    console.log(`    persisted toolCalls: ${toolCalls.length}`);
    for (const tc of toolCalls) {
      if (tc && typeof tc === 'object') {
        const t = tc as Record<string, unknown>;
        console.log(`      - slug=${String(t.slug)} success=${String(t.success)}`);
      }
    }
    if (r.errorCode) console.log(`    errorCode: ${r.errorCode}  errorMessage: ${r.errorMessage}`);
  }

  // ── 3. Cross-check: the actual conversation messages ───────────────────
  // The subject side calls `streamChat` with no contextType — it writes a
  // normal AiConversation with `AiMessage` rows. If the LLM emitted any
  // tool calls, there will be `tool` role rows; if not, only user +
  // assistant rows.
  if (run.subjectKind === 'agent' && results.length > 0) {
    console.log('\n━ Conversation cross-check ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    // The worker leaves no FK from CaseResult → AiConversation, so we
    // sample by the most recent N conversations for the subject agent
    // around the run's window and inspect their message roles.
    const since = run.startedAt ?? run.createdAt;
    const convos = await prisma.aiConversation.findMany({
      where: {
        agentId: run.agentId ?? '',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      include: { messages: { select: { role: true, content: true } } },
      take: 10,
    });
    console.log(`  Found ${convos.length} conversation(s) since the run started.`);
    for (const c of convos) {
      const byRole = c.messages.reduce<Record<string, number>>((acc, m) => {
        acc[m.role] = (acc[m.role] ?? 0) + 1;
        return acc;
      }, {});
      const firstUser = c.messages.find((m) => m.role === 'user')?.content?.slice(0, 80) ?? '';
      console.log(
        `    convo ${c.id}: ${JSON.stringify(byRole)}  first-user="${firstUser.replace(/\n/g, ' ')}"`
      );
    }
    const totalToolMessages = convos.reduce(
      (acc, c) => acc + c.messages.filter((m) => m.role === 'tool').length,
      0
    );
    console.log(`\n  Total tool-role messages across these conversations: ${totalToolMessages}`);
    if (totalToolMessages === 0) {
      console.log(
        `  ⇒ The LLM never invoked any tool. Compare against the capability bindings above:`
      );
      console.log(`    • If the tool is unbound/disabled, that's the root cause.`);
      console.log(
        `    • If the tool IS bound + enabled, the LLM is choosing not to call it — likely a`
      );
      console.log(`      systemInstructions issue (no directive to use the tool) or a model that`);
      console.log(`      doesn't support function calling.`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main()
  .catch((err) => {
    console.error('Diagnose script crashed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
