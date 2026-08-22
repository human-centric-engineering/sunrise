/**
 * Judge-agent driver — shared helper between the `judge_agent` grader
 * (batch evaluation worker) and the `judge_call` workflow step type.
 *
 * Both surfaces drive an `AiAgent` with `kind = 'judge'` against a
 * structured user message and parse a `{score, reasoning, evaluationSteps?}`
 * envelope back. The grader path runs inside the evaluation worker
 * (one judge call per dataset case); the step path runs inside a
 * workflow execution (one judge call per workflow run, with the result
 * routable on score thresholds via `route` step).
 *
 * Extracted from `graders/model/judge-agent.ts` so neither surface has
 * to copy the prompt-assembly + JSON-parsing rules. The grader file
 * remains the canonical caller; the step type calls this same helper.
 */

import { logger } from '@/lib/logging';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';

export interface DriveJudgeInput {
  /** Slug of the AiAgent (kind=judge) to drive. */
  agentSlug: string;
  /** User-id passed through to streamChat for ownership-scoped reads. */
  userId: string;
  /** The "QUESTION" payload — typically the dataset case `input`. */
  question: string;
  /** The "ANSWER" payload — typically the subject's output. */
  answer: string;
  /** Optional reference answer / expected output. */
  expectedOutput?: string;
  /** Citations the subject's answer carried (empty array if none). */
  citations?: Array<{
    marker: number;
    documentName: string | null;
    excerpt: string;
  }>;
  /** Tool calls the subject made while producing the answer. */
  toolCalls?: Array<{
    slug: string;
    args?: Record<string, unknown>;
  }>;
  /** Subject brand-voice text, only honoured by `eval-judge-brand-voice`. */
  subjectBrandVoice?: string;
  /**
   * Optional `{ evaluationRunId, role: 'judge' | 'subject' }` payload spread
   * into the underlying chat call's `costLogMetadata`.
   *
   * **Both callers set it.** This used to say the workflow step "usually omits
   * it because the engine already tags rows via
   * `ExecuteOptions.costLogMetadata`" — which was false, and was the reason the
   * `judge_call` executor withheld it for as long as it did: nothing here logs
   * through an executor. `driveJudgeAgent` goes to `drainStreamChat` → the
   * streaming chat handler, whose `logCost` calls tag from
   * `request.costLogMetadata` and from nothing else (#600).
   */
  costLogMetadata?: Record<string, unknown>;
}

export interface DriveJudgeResult {
  score: number | null;
  reasoning: string;
  evaluationSteps?: string[];
  /** Underlying chat cost (USD). */
  costUsd: number;
  /** Token totals from the chat call. */
  tokenUsage: { input: number; output: number };
  /**
   * Set when the call failed at the chat layer or the response wasn't
   * a valid `{score, reasoning}` JSON envelope. The reasoning field
   * carries a human-readable explanation; `score` is `null`.
   */
  errorCode?: string;
}

const MAX_CITATIONS = 12;
const MAX_EXCERPT_CHARS = 600;
const MAX_TOOL_CALLS = 20;

interface RawJudgeOutput {
  score: number | null;
  reasoning: string;
  evaluationSteps?: string[];
}

/**
 * Drive a named judge agent against the supplied case payload.
 *
 * Returns a shaped result — never throws. Chat-layer failures (provider
 * down, budget exceeded, etc.) and parse failures both come back as
 * `{ score: null, errorCode, reasoning: <explanation> }` so callers can
 * record a typed "skip this metric" result rather than a hard throw.
 */
export async function driveJudgeAgent(input: DriveJudgeInput): Promise<DriveJudgeResult> {
  const userMessage = buildJudgePrompt({
    question: input.question,
    answer: input.answer,
    expectedOutput: input.expectedOutput,
    citations: input.citations ?? [],
    toolCalls: input.toolCalls ?? [],
    subjectBrandVoice: input.subjectBrandVoice,
  });

  const result = await drainStreamChat({
    agentSlug: input.agentSlug,
    userId: input.userId,
    message: userMessage,
    entityContext: {
      source: 'evaluation_judge',
      judgeAgentSlug: input.agentSlug,
    },
    ...(input.costLogMetadata ? { costLogMetadata: input.costLogMetadata } : {}),
  });

  if (result.errorCode) {
    return {
      score: null,
      reasoning: `judge call error: ${result.errorCode}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
      costUsd: result.costUsd,
      tokenUsage: result.tokenUsage,
      errorCode: result.errorCode,
    };
  }

  const parsed = parseJudgeOutput(result.assistantText);
  if (!parsed) {
    logger.warn('judge driver: malformed JSON from judge', {
      agentSlug: input.agentSlug,
      preview: result.assistantText.slice(0, 200),
    });
    return {
      score: null,
      reasoning: 'judge call: response was not valid {score, reasoning} JSON',
      costUsd: result.costUsd,
      tokenUsage: result.tokenUsage,
      errorCode: 'malformed_judge_response',
    };
  }

  const out: DriveJudgeResult = {
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

interface JudgePromptInput {
  question: string;
  answer: string;
  expectedOutput?: string;
  citations: Array<{ marker: number; documentName: string | null; excerpt: string }>;
  toolCalls: Array<{ slug: string; args?: Record<string, unknown> }>;
  subjectBrandVoice?: string;
}

/**
 * Assemble the structured user message every judge agent expects. The
 * shape is fixed (see seeded judge `systemInstructions`):
 *
 *   QUESTION: <userInput>
 *   ANSWER: <modelOutput>
 *   [optional] EXPECTED ANSWER: <expectedOutput>
 *   [optional] CITED SOURCES: <JSON array>
 *   [optional] TOOL CALLS: <JSON array>
 *   [optional] SUBJECT BRAND VOICE: <brandVoiceInstructions>
 *
 * Each section is gated on the presence of the corresponding input so
 * judges that don't need the field don't see an empty line for it.
 */
export function buildJudgePrompt(input: JudgePromptInput): string {
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

/**
 * Parse the judge's reply. Snake-case in the wire shape (`evaluation_steps`),
 * camelCase in TypeScript. Returns `null` when the response can't be
 * coerced to `{ score: number | null, reasoning: string }`.
 */
export function parseJudgeOutput(raw: string): RawJudgeOutput | null {
  return tryParseJson<RawJudgeOutput>(raw, (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.reasoning !== 'string') return null;
    const stepsRaw = (obj as { evaluation_steps?: unknown }).evaluation_steps;
    const evaluationSteps = Array.isArray(stepsRaw)
      ? stepsRaw.filter((s): s is string => typeof s === 'string')
      : undefined;
    const base = (s: number | null): RawJudgeOutput =>
      evaluationSteps && evaluationSteps.length > 0
        ? { score: s, reasoning: obj.reasoning as string, evaluationSteps }
        : { score: s, reasoning: obj.reasoning as string };
    if (obj.score === null) return base(null);
    if (typeof obj.score !== 'number' || !Number.isFinite(obj.score)) return null;
    return base(obj.score);
  });
}
