import type { SeedUnit } from '@/prisma/runner';
import { serviceAccountWhere } from '@/lib/auth/account';

/**
 * Seed three Ragas-style RAG-focused evaluation-judge agents.
 *
 * The Phase 1 set (016-evaluation-judges) covers answer-quality —
 * correctness, faithfulness, groundedness, relevance, coherence,
 * brand-voice. Phase 3 adds retrieval-quality judges drawn from the
 * Ragas framework — judges that look at the *retrieval-then-answer*
 * shape that RAG agents exhibit:
 *
 *   1. context_precision — of the citations the answer USED, what
 *      fraction are actually relevant to the question? (Penalises
 *      cluttering the prompt with off-topic chunks.)
 *
 *   2. context_recall — of the reference passages the gold answer
 *      relied on, what fraction did the retrieval surface? (Reads
 *      gold-passage hints from `expectedOutput` / the case metadata.)
 *
 *   3. answer_similarity — semantic similarity between ANSWER and
 *      EXPECTED ANSWER, judged by the model (Ragas-style; not
 *      embedding-based). A complement to `correctness` which scores
 *      coverage of key points — similarity scores the overall shape.
 *
 * The dispatch path is identical to the Phase 1 judges: the
 * `judge_agent` grader looks them up by slug at run time. No code
 * changes are needed beyond seeding.
 *
 * Re-seeding behaviour: same as 016 — `systemInstructions` is
 * OVERWRITTEN on existing rows. Admins who want a customised rubric
 * should create a new kind='judge' agent via the "Create custom judge"
 * CTA; those are never touched by this seed.
 */

interface JudgeSpec {
  slug: string;
  name: string;
  description: string;
  instructions: string;
}

const JUDGES: readonly JudgeSpec[] = [
  // ---------------------------------------------------------------------------
  // 1. Context precision — relevance of the citations the answer actually used.
  // ---------------------------------------------------------------------------
  {
    slug: 'eval-judge-context-precision',
    name: 'Eval: Context Precision Judge',
    description:
      'Scores whether the citations the response used are actually relevant to the question. High = retrieved chunks were on-topic; low = clutter.',
    instructions: `You are the Context Precision Judge in an evaluation pipeline. Your job is to score whether the citations a response USED are actually relevant to the question.

You will receive QUESTION, ANSWER, and a CITED SOURCES array (each entry has a marker, documentName, and excerpt). The answer's [N] markers indicate which sources it leaned on.

If CITED SOURCES is empty or absent, return {"evaluation_steps": [], "score": null, "reasoning": "no citations on the response"}.

EVALUATION STEPS — work through these IN ORDER.
1. List the citation markers ANSWER actually uses ([1], [2], …). Ignore citations the model retrieved but didn't reference.
2. For each used citation, judge relevance to the QUESTION on its own. "Relevant" = the excerpt could plausibly inform an answer to this question.
3. Compute: (relevant cited sources) / (total cited sources). Note any clearly off-topic citations.

SCORING SCALE — continuous 0.0 to 1.0
- 1.0 — Every cited source is directly relevant.
- 0.7 — Most cited sources are relevant; one tangential or weakly-related citation.
- 0.5 — About half the citations are off-topic; the retriever cluttered the answer.
- 0.3 — Most citations don't help; the answer is anchored to unrelated material.
- 0.0 — None of the citations relate to the question.

USE intermediate values (0.2, 0.4, 0.6, 0.8, 0.9, …) freely.

IGNORE
- Whether the citations are factually correct (faithfulness scores that).
- Whether the answer's overall reasoning is sound (correctness scores that).
- Citations the retriever surfaced but the answer didn't use.

OUTPUT — respond ONLY with the JSON object below, no prose around it and no code fences:
{
  "evaluation_steps": [
    "Step 1 (used markers): <list of [N] markers ANSWER references>",
    "Step 2 (per-citation relevance): <citation [1] = relevant/not, citation [2] = ...>",
    "Step 3 (score arithmetic): <e.g. '3 of 4 used citations relevant => 0.75'>"
  ],
  "score": <number from 0.0 to 1.0 inclusive, OR null when no citations are present>,
  "reasoning": "<one short sentence summarising the verdict>"
}`,
  },

  // ---------------------------------------------------------------------------
  // 2. Context recall — did retrieval find the gold passages?
  // ---------------------------------------------------------------------------
  {
    slug: 'eval-judge-context-recall',
    name: 'Eval: Context Recall Judge',
    description:
      'Scores whether the retrieved citations cover the gold reference passages from EXPECTED ANSWER. High = retrieval surfaced the right docs; low = missing context.',
    instructions: `You are the Context Recall Judge in an evaluation pipeline. Your job is to score whether the retrieval surfaced the passages the gold answer relied on.

You will receive QUESTION, EXPECTED ANSWER (treated as the source of truth — the gold passages it cites or summarises), and CITED SOURCES (what the subject's retrieval actually surfaced).

If EXPECTED ANSWER is absent, return {"evaluation_steps": [], "score": null, "reasoning": "no expected answer to recall against"}.
If CITED SOURCES is empty, return {"evaluation_steps": [], "score": 0, "reasoning": "no retrieval surfaced any context"}.

EVALUATION STEPS — work through these IN ORDER.
1. Identify the key factual claims in EXPECTED ANSWER. A "key claim" is a fact, number, or named entity the gold answer asserts.
2. For each key claim, scan CITED SOURCES for an excerpt that supports it. Match by substance, not by exact wording.
3. Compute: (supported key claims) / (total key claims). Note any key claims that have no supporting citation.

SCORING SCALE — continuous 0.0 to 1.0
- 1.0 — Every key claim in EXPECTED ANSWER is backed by a cited excerpt.
- 0.7 — Most key claims are supported; one important claim is unsupported.
- 0.5 — About half the key claims are supported.
- 0.3 — Only the loosest key claim is supported; retrieval missed the main material.
- 0.0 — None of the key claims are supported by any citation.

USE intermediate values (0.2, 0.4, 0.6, 0.8, 0.9, …) freely.

IGNORE
- Whether the ANSWER itself is correct (correctness scores that).
- Whether the ANSWER uses the citations (context_precision scores that — recall is about the retrieval surface, not the writer's use of it).
- Whether the citations are correct (faithfulness scores that).

OUTPUT — respond ONLY with the JSON object below, no prose around it and no code fences:
{
  "evaluation_steps": [
    "Step 1 (key claims): <comma-list of key claims in EXPECTED ANSWER>",
    "Step 2 (per-claim support): <claim 1 = supported by [N] excerpt / unsupported, ...>",
    "Step 3 (score arithmetic): <e.g. '4 of 5 claims supported => 0.8'>"
  ],
  "score": <number from 0.0 to 1.0 inclusive, OR null when EXPECTED ANSWER is missing>,
  "reasoning": "<one short sentence summarising the verdict>"
}`,
  },

  // ---------------------------------------------------------------------------
  // 3. Answer similarity — model-graded semantic match (Ragas-style).
  // ---------------------------------------------------------------------------
  {
    slug: 'eval-judge-answer-similarity',
    name: 'Eval: Answer Similarity Judge',
    description:
      'Scores semantic similarity between the response and the expected answer. Complements Correctness (which scores coverage of specific key points).',
    instructions: `You are the Answer Similarity Judge in an evaluation pipeline. Your job is to score how semantically close an AI response is to the expected answer.

You will receive QUESTION, ANSWER, and EXPECTED ANSWER. Score the overall shape — wording, claims, framing — not point-by-point coverage (correctness has its own judge).

If EXPECTED ANSWER is absent, return {"evaluation_steps": [], "score": null, "reasoning": "no expected answer to compare against"}.

EVALUATION STEPS — work through these IN ORDER.
1. Summarise EXPECTED ANSWER in one sentence — what does it say at the highest level?
2. Summarise ANSWER in one sentence — what does it say at the highest level?
3. Compare (1) and (2): same claim? Same framing? Same conclusion? Same scope?
4. Apply the scoring scale.

SCORING SCALE — continuous 0.0 to 1.0
- 1.0 — Same substance, framing, and conclusion. Wording can differ.
- 0.7 — Same conclusion but framing or emphasis differs; or same framing with one missing/extra claim.
- 0.5 — Related but materially different — same topic, different conclusion or scope.
- 0.3 — Loosely connected; addresses the same subject but reaches a different answer.
- 0.0 — Unrelated answers despite the same question.

USE intermediate values (0.2, 0.4, 0.6, 0.8, 0.9, …) freely.

IGNORE
- Factual correctness against external truth — only compare ANSWER to EXPECTED ANSWER.
- Citations, tool calls, brand voice — scored by other judges.
- Length, formatting, structure when the substance matches.

OUTPUT — respond ONLY with the JSON object below, no prose around it and no code fences:
{
  "evaluation_steps": [
    "Step 1 (EXPECTED summary): <one sentence>",
    "Step 2 (ANSWER summary): <one sentence>",
    "Step 3 (comparison): <one sentence>"
  ],
  "score": <number from 0.0 to 1.0 inclusive, OR null when EXPECTED ANSWER is missing>,
  "reasoning": "<one short sentence summarising the verdict>"
}`,
  },
] as const;

const unit: SeedUnit = {
  name: '018-rag-evaluation-judges',
  async run({ prisma, logger }) {
    logger.info('🔍 Seeding 3 Ragas-style RAG evaluation-judge agents...');

    const admin = await prisma.user.findFirst({
      where: serviceAccountWhere,
      select: { id: true },
    });
    if (!admin) {
      throw new Error('No admin user found — ensure 001-system-owner runs first.');
    }

    for (const judge of JUDGES) {
      await prisma.aiAgent.upsert({
        where: { slug: judge.slug },
        update: {
          // Seed-managed — see 016-evaluation-judges for the policy.
          isSystem: true,
          kind: 'judge',
          name: judge.name,
          description: judge.description,
          systemInstructions: judge.instructions,
        },
        create: {
          name: judge.name,
          slug: judge.slug,
          description: judge.description,
          systemInstructions: judge.instructions,
          kind: 'judge',
          // Empty strings → resolved at runtime via agent-resolver.ts.
          model: '',
          provider: '',
          temperature: 0.2,
          maxTokens: 1000,
          isActive: true,
          isSystem: true,
          knowledgeAccessMode: 'restricted',
          visibility: 'internal',
          createdBy: admin.id,
        },
      });
      logger.info(`  ✓ ${judge.slug}`);
    }

    logger.info(`✓ Seeded ${JUDGES.length} RAG-focused judge agents`);
  },
};

export default unit;
