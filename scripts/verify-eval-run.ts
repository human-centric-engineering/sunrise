/**
 * End-to-end verification: seed a small dataset + run, drive the worker
 * directly, and report what happened.
 *
 * Usage:  tsx -r dotenv/config scripts/verify-eval-run.ts dotenv_config_path=.env.local
 *
 * Or via the npm helper: npm run verify:eval-run
 *
 * Bypasses HTTP/auth (uses Prisma directly to set up state) so we can
 * exercise the worker on the dev DB without juggling cookies. This is a
 * verification harness, not a test fixture — wipes the run + dataset it
 * creates on success so the dev DB stays clean.
 */

const ADMIN_EMAIL = 'johndurrant70@gmail.com';
const AGENT_SLUG = 'pattern-advisor';

/** Tiny dataset — three on-topic questions for the Pattern Advisor agent. */
const CASES = [
  {
    input: 'What is the chain-of-thought prompting pattern?',
    expectedOutput: 'chain',
  },
  {
    input: 'When would I use the ReAct agent pattern?',
    expectedOutput: 'react',
  },
  {
    input: 'Briefly: what does RAG stand for?',
    expectedOutput: 'retrieval',
  },
];

/** Metrics — one heuristic (cheap), one model-graded (one judge call per case). */
/**
 * Metrics — one heuristic (cheap) and two judge-agent calls per case.
 * Exercises the agent-as-judges path end-to-end: streamChat drives the
 * seeded `eval-judge-relevance` and `eval-judge-coherence` agents and
 * the worker parses each judge's {score, reasoning} response.
 */
const METRIC_CONFIGS = [
  { slug: 'contains', config: { caseInsensitive: true } },
  { slug: 'judge_agent', config: { agentSlug: 'eval-judge-relevance' } },
  { slug: 'judge_agent', config: { agentSlug: 'eval-judge-coherence' } },
];

async function main(): Promise<void> {
  // Dynamic imports so dotenv (loaded via tsx -r) populates env BEFORE
  // any @/lib/env-consuming module is evaluated.
  const { prisma } = await import('@/lib/db/client');
  const { processPendingEvaluationRuns } =
    await import('@/lib/orchestration/evaluations/run-worker');
  const { hashParsedCases } = await import('@/lib/orchestration/evaluations/datasets/hash');

  console.log('━━━ Eval-run verification ━━━');

  // 1. Resolve admin + agent
  const user = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!user) throw new Error(`No user with email ${ADMIN_EMAIL}`);
  const agent = await prisma.aiAgent.findUnique({ where: { slug: AGENT_SLUG } });
  if (!agent) throw new Error(`No agent with slug ${AGENT_SLUG}`);
  console.log(`✓ admin=${user.email}  agent=${agent.slug}`);

  // 2. Seed dataset + cases
  const contentHash = hashParsedCases(CASES);
  const dataset = await prisma.aiDataset.create({
    data: {
      userId: user.id,
      name: `[verify] ${new Date().toISOString()}`,
      tags: ['verify'],
      caseCount: CASES.length,
      contentHash,
      source: 'manual',
    },
  });
  await prisma.aiDatasetCase.createMany({
    data: CASES.map((c, i) => ({
      datasetId: dataset.id,
      position: i,
      input: c.input,
      expectedOutput: c.expectedOutput,
    })),
  });
  console.log(`✓ dataset=${dataset.id}  cases=${CASES.length}  hash=${contentHash.slice(0, 12)}…`);

  // 3. Queue a run
  const run = await prisma.aiEvaluationRun.create({
    data: {
      userId: user.id,
      name: `[verify] ${new Date().toISOString()}`,
      subjectKind: 'agent',
      agentId: agent.id,
      datasetId: dataset.id,
      datasetContentHash: contentHash,
      metricConfigs: METRIC_CONFIGS,
      status: 'queued',
      progress: { casesTotal: CASES.length, casesDone: 0, casesFailed: 0 },
    },
  });
  console.log(`✓ run=${run.id}  status=queued`);

  // 4. Drive the worker. Each invocation drains within a ~45s soft
  //    budget; a long batch (slow model + judge per case) may need
  //    multiple ticks. Loop until the run is terminal — this also
  //    exercises the resume-from-cursor path between ticks.
  console.log('→ draining via processPendingEvaluationRuns() ticks…');
  const MAX_TICKS = 6;
  for (let tickIdx = 1; tickIdx <= MAX_TICKS; tickIdx++) {
    const tickStart = Date.now();
    const outcome = await processPendingEvaluationRuns();
    const tickMs = Date.now() - tickStart;
    console.log(`  tick ${tickIdx}: ${JSON.stringify(outcome)}  durationMs=${tickMs}`);
    const status = await prisma.aiEvaluationRun.findUniqueOrThrow({
      where: { id: run.id },
      select: { status: true, progress: true },
    });
    console.log(`     status=${status.status}  progress=${JSON.stringify(status.progress)}`);
    if (status.status !== 'queued' && status.status !== 'running') break;
    if (outcome.claimed === 0) {
      // The worker found nothing claimable — likely the lease hasn't
      // expired yet. Wait the lease TTL and retry.
      console.log('     (no claim — sleeping briefly)');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // 5. Inspect the final state
  const finalRun = await prisma.aiEvaluationRun.findUniqueOrThrow({
    where: { id: run.id },
    include: { results: { orderBy: { casePosition: 'asc' } } },
  });
  console.log(
    `✓ final status=${finalRun.status}  cost=$${(finalRun.totalCostUsd ?? 0).toFixed(4)}`
  );
  console.log(`  summary: ${JSON.stringify(finalRun.summary, null, 2)}`);
  console.log(`  ${finalRun.results.length} case results:`);
  for (const r of finalRun.results) {
    const scores = r.metricScores as Record<string, { score: number | null; passed?: boolean }>;
    const summary = Object.entries(scores)
      .map(([slug, s]) => {
        const v = s.score === null ? 'n/a' : s.score.toFixed(2);
        const p = s.passed === undefined ? '' : s.passed ? ' ✓' : ' ✗';
        return `${slug}=${v}${p}`;
      })
      .join('  ');
    const errStr = r.errorCode ? `  ERR(${r.errorCode})` : '';
    const outputPreview = r.subjectOutput.slice(0, 80).replace(/\n/g, ' ');
    console.log(`    #${r.casePosition}  ${summary}  $${r.costUsd.toFixed(4)}${errStr}`);
    console.log(`         → "${outputPreview}…"`);
  }

  // 6. Cleanup — keep the dev DB tidy unless KEEP=1 is set
  const keep = process.env.KEEP === '1';
  if (keep) {
    console.log(`(KEEP=1 set — leaving dataset ${dataset.id} and run ${run.id} in place)`);
  } else {
    await prisma.aiEvaluationRun.delete({ where: { id: run.id } });
    await prisma.aiDataset.delete({ where: { id: dataset.id } });
    console.log('✓ cleanup done');
  }

  console.log(
    `\n${finalRun.status === 'completed' ? '🟢 VERIFICATION PASSED' : '🔴 VERIFICATION FAILED'}`
  );
  await prisma.$disconnect();
  process.exit(finalRun.status === 'completed' ? 0 : 1);
}

main().catch((err) => {
  console.error('💥', err);
  process.exit(1);
});
