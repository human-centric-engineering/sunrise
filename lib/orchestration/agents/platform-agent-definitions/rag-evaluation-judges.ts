/**
 * The three Ragas-style retrieval-quality judges — context precision, context
 * recall and answer similarity. Dispatched exactly like the answer-quality
 * judges in `evaluation-judges.ts`: the `judge_agent` grader looks them up by
 * slug at run time.
 */
import type { PlatformAgentDefinition } from '@/lib/orchestration/agents/platform-agents';

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

export const RAG_EVALUATION_JUDGE_AGENTS: readonly PlatformAgentDefinition[] = JUDGES.map(
  (judge): PlatformAgentDefinition => ({
    slug: judge.slug,
    audience: 'every-org',
    agent: {
      name: judge.name,
      description: judge.description,
      systemInstructions: judge.instructions,
      kind: 'judge',
      temperature: 0.2,
      maxTokens: 1000,
      knowledgeAccessMode: 'restricted',
    },
    capabilities: [],
    knowledgeTags: [],
  })
);
