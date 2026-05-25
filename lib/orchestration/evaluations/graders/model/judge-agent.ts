/**
 * Grader: judge_agent.
 *
 * The single model-graded entry in the registry — drives an `AiAgent`
 * with `kind = 'judge'` to score the case. Config carries the slug of
 * the judge agent to use:
 *
 *     { slug: 'judge_agent', config: { agentSlug: 'eval-judge-relevance' } }
 *
 * Replaces the per-rubric graders (faithfulness/groundedness/relevance/
 * custom_rubric) the previous design shipped. Every model grader is now
 * an `AiAgent` row — admins edit the rubric in the agent form, swap
 * models without code changes, attach knowledge documents to specialist
 * judges, see judge spend on the per-agent costs page, etc.
 *
 * The 6 built-in judges live as seeded `isSystem=true` agents (see
 * `prisma/seeds/016-evaluation-judges.ts`). Custom judges are any
 * `kind='judge'` agent the operator creates via the agent form.
 *
 * The structured user message the worker builds for every judge call:
 *
 *     QUESTION: <userInput>
 *     ANSWER: <modelOutput>
 *     [optional] EXPECTED ANSWER: <expectedOutput>
 *     [optional] CITED SOURCES: <JSON array>
 *     [optional] TOOL CALLS: <JSON array>
 *     [optional] SUBJECT BRAND VOICE: <subject agent's brandVoiceInstructions>
 *
 * Each judge's `systemInstructions` tells it which fields to USE and
 * IGNORE. The judge returns `{score, reasoning}` JSON which the grader
 * parses.
 */

import { z } from 'zod';
import { logger } from '@/lib/logging';
import { registerGrader } from '@/lib/orchestration/evaluations/graders/registry';
import type {
  Grader,
  GraderInput,
  GraderResult,
} from '@/lib/orchestration/evaluations/graders/types';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

const configSchema = z.object({
  /** Slug of the judge agent (an AiAgent with kind='judge'). */
  agentSlug: z.string().min(1),
  /**
   * Subject brand-voice text. The worker interpolates this from the
   * subject agent's `brandVoiceInstructions` at run time when the
   * judge is `eval-judge-brand-voice` — the picker UI never sets it
   * directly. Other judges ignore it.
   */
  subjectBrandVoice: z.string().optional(),
});

type Config = z.infer<typeof configSchema>;

interface JudgeOutput {
  score: number | null;
  reasoning: string;
  /** G-Eval chain-of-thought trace — optional for back-compat. */
  evaluationSteps?: string[];
}

async function grade(input: GraderInput & { config: Config }): Promise<GraderResult> {
  if (!input.judge) {
    return { score: null, reasoning: 'judge_agent: no judge user context — skipped' };
  }

  const userMessage = buildJudgePrompt({
    question: input.userInput,
    answer: input.modelOutput,
    expectedOutput: input.expectedOutput,
    citations: input.citations ?? [],
    toolCalls: input.toolCalls ?? [],
    subjectBrandVoice: input.config.subjectBrandVoice,
  });

  const result = await drainStreamChat({
    agentSlug: input.config.agentSlug,
    userId: input.judge.userId,
    message: userMessage,
    // Tag the conversation so the conversations list can filter judge
    // runs out by default. Drill-in from the run-detail page can still
    // surface them when an admin wants to inspect a specific judge call.
    entityContext: {
      source: 'evaluation_judge',
      judgeAgentSlug: input.config.agentSlug,
    },
    ...(input.judge.evaluationRunId
      ? {
          costLogMetadata: {
            evaluationRunId: input.judge.evaluationRunId,
            role: 'judge',
            judgeAgentSlug: input.config.agentSlug,
          },
        }
      : {}),
  });

  if (result.errorCode) {
    return {
      score: null,
      reasoning: `judge_agent error: ${result.errorCode}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
      costUsd: result.costUsd,
      tokenUsage: result.tokenUsage,
    };
  }

  const parsed = parseJudgeOutput(result.assistantText);
  if (!parsed) {
    logger.warn('judge_agent: malformed JSON from judge', {
      agentSlug: input.config.agentSlug,
      preview: result.assistantText.slice(0, 200),
    });
    return {
      score: null,
      reasoning: 'judge_agent: response was not valid {score, reasoning} JSON',
      costUsd: result.costUsd,
      tokenUsage: result.tokenUsage,
    };
  }

  const out: GraderResult = {
    score: parsed.score,
    reasoning: parsed.reasoning,
    costUsd: result.costUsd,
    tokenUsage: result.tokenUsage,
  };
  if (parsed.evaluationSteps && parsed.evaluationSteps.length > 0) {
    out.evaluationSteps = parsed.evaluationSteps;
  }
  return out;
}

export const judgeAgentGrader: Grader<Config> = {
  slug: 'judge_agent',
  family: 'model',
  // The judge itself decides whether it needs `expectedOutput` (e.g.
  // the Correctness judge returns null when it's missing). Run-level
  // preflight can't know per-judge requirements without an extra
  // round-trip, so we let the judge handle the null case itself.
  referenceRequired: false,
  configSchema,
  defaultConfig: { agentSlug: '' },
  grade,
  description:
    "Drives an AiAgent with kind='judge' to score the case. Pick from the 6 built-in judges or create your own. The agent's systemInstructions IS the rubric — admins edit them in the agent form.",
};

registerGrader(judgeAgentGrader);

// ---------------------------------------------------------------------------
// Prompt assembly + response parsing
// ---------------------------------------------------------------------------

interface JudgePromptInput {
  question: string;
  answer: string;
  expectedOutput?: string;
  citations: Array<{ marker: number; documentName: string | null; excerpt: string }>;
  toolCalls: Array<{ slug: string; args?: Record<string, unknown> }>;
  subjectBrandVoice?: string;
}

const MAX_CITATIONS = 12;
const MAX_EXCERPT_CHARS = 600;
const MAX_TOOL_CALLS = 20;

function buildJudgePrompt(input: JudgePromptInput): string {
  const lines: string[] = [];
  lines.push(`QUESTION: ${input.question}`);
  lines.push('');
  lines.push(`ANSWER: ${input.answer}`);

  if (input.expectedOutput) {
    lines.push('');
    lines.push(`EXPECTED ANSWER: ${input.expectedOutput}`);
  }

  if (input.citations.length > 0) {
    const trimmed = input.citations.slice(0, MAX_CITATIONS).map((c) => ({
      marker: c.marker,
      documentName: c.documentName,
      excerpt: truncate(c.excerpt, MAX_EXCERPT_CHARS),
    }));
    lines.push('');
    lines.push(`CITED SOURCES: ${JSON.stringify(trimmed)}`);
  }

  if (input.toolCalls.length > 0) {
    const trimmed = input.toolCalls.slice(0, MAX_TOOL_CALLS).map((t) => ({
      slug: t.slug,
      args: t.args,
    }));
    lines.push('');
    lines.push(`TOOL CALLS: ${JSON.stringify(trimmed)}`);
  }

  if (input.subjectBrandVoice && input.subjectBrandVoice.trim()) {
    lines.push('');
    lines.push(`SUBJECT BRAND VOICE: ${input.subjectBrandVoice.trim()}`);
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function parseJudgeOutput(raw: string): JudgeOutput | null {
  return tryParseJson<JudgeOutput>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.reasoning !== 'string') return null;
    // evaluation_steps is the new v2 contract; accept its absence so a
    // judge agent customised by an admin (with an older rubric) still
    // parses. Snake-case in the wire shape, camelCase in TS.
    const stepsRaw = (obj as { evaluation_steps?: unknown }).evaluation_steps;
    const evaluationSteps = Array.isArray(stepsRaw)
      ? stepsRaw.filter((s): s is string => typeof s === 'string')
      : undefined;
    const base = (s: number | null): JudgeOutput =>
      evaluationSteps && evaluationSteps.length > 0
        ? { score: s, reasoning: obj.reasoning as string, evaluationSteps }
        : { score: s, reasoning: obj.reasoning as string };
    if (obj.score === null) return base(null);
    if (typeof obj.score !== 'number' || !Number.isFinite(obj.score)) return null;
    return base(obj.score);
  });
}
