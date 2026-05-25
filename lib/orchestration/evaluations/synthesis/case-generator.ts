/**
 * Synthetic case generator.
 *
 * Composes a structured user message from a seed (KB chunks or prior
 * failures), drives the `eval-case-generator` agent via `drainStreamChat`,
 * parses the JSON envelope, and returns proposed cases. **Does not
 * write** — preview-only. The API route writes accepted cases via
 * `appendCasesToDataset`.
 *
 * Cost is tagged: every chat call from this path stamps
 * `costLogMetadata: { role: 'generator', agentSlug }` so synthesis spend
 * is attributable in the cost analytics. Mirrors the same pattern that
 * Phase 2.0 added for subject + judge calls in eval runs.
 */

import { z } from 'zod';
import { logger } from '@/lib/logging';
import { ValidationError } from '@/lib/api/errors';
import { drainStreamChat } from '@/lib/orchestration/evaluations/drain-stream-chat';
import { tryParseJson } from '@/lib/orchestration/evaluations/parse-structured';
import {
  loadFailureSeed,
  loadKbSeed,
  type FailureSeed,
  type KbSeedChunk,
} from '@/lib/orchestration/evaluations/synthesis/seed-loader';

export const GENERATOR_AGENT_SLUG = 'eval-case-generator';
const MAX_COUNT = 25;

export type SynthesisMode = 'kb' | 'failure_mining';

export interface ProposedCase {
  input: string | Record<string, unknown>;
  expectedOutput?: string;
  /**
   * Always populated after `generateCases` returns — the function
   * stamps `source`, `mode`, `generatorAgentSlug`, and `generatedAt`
   * onto every proposed case before returning. Typed as required so
   * the route + UI don't have to defensively check for `undefined`.
   */
  metadata: Record<string, unknown>;
}

/** Wire shape from the generator agent's JSON envelope, pre-tagging. */
interface RawProposedCase {
  input: string | Record<string, unknown>;
  expectedOutput?: string;
  metadata?: Record<string, unknown>;
}

export interface GenerateCasesParams {
  /** Subject agent the proposed cases will eventually be evaluated against. */
  agentId: string;
  userId: string;
  mode: SynthesisMode;
  /** How many cases to propose (1–25). */
  count: number;
  /** Optional KB-mode topic anchor — sent to the generator as guidance. */
  topic?: string;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

export interface GenerateCasesResult {
  cases: ProposedCase[];
  /** Cost of the generator LLM call, exposed so the route can log it. */
  costUsd: number;
  tokenUsage: { input: number; output: number };
}

const proposedCaseSchema = z.object({
  input: z.union([z.string().min(1).max(50_000), z.record(z.string(), z.unknown())]),
  expectedOutput: z.string().max(50_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const generatorResponseSchema = z.object({
  cases: z.array(proposedCaseSchema).min(1).max(MAX_COUNT),
});

export async function generateCases(params: GenerateCasesParams): Promise<GenerateCasesResult> {
  if (params.count < 1 || params.count > MAX_COUNT) {
    throw new ValidationError(`count must be between 1 and ${MAX_COUNT}`);
  }

  // 1. Load seeds for the chosen mode.
  let prompt: string;
  if (params.mode === 'kb') {
    const chunks = await loadKbSeed({
      agentId: params.agentId,
      ...(params.topic ? { topic: params.topic } : {}),
    });
    if (chunks.length === 0) {
      throw new ValidationError(
        'No knowledge chunks available for this agent — grant the agent access to at least one document before synthesising KB-grounded cases.'
      );
    }
    prompt = buildKbPrompt(chunks, params.count, params.topic);
  } else {
    // userId is required — failure-seed reads `AiEvaluationRun` rows
    // which are user-scoped; without it admin A would pull admin B's
    // prior runs (and their case content) into A's generator prompt.
    const failures = await loadFailureSeed({
      agentId: params.agentId,
      userId: params.userId,
    });
    if (failures.length === 0) {
      throw new ValidationError(
        'No low-scoring prior cases for this agent — run an evaluation that produces failures before synthesising hardened variants.'
      );
    }
    prompt = buildFailurePrompt(failures, params.count);
  }

  // 2. Call the generator agent.
  const result = await drainStreamChat({
    agentSlug: GENERATOR_AGENT_SLUG,
    userId: params.userId,
    message: prompt,
    entityContext: {
      source: 'evaluation_synthesis',
      mode: params.mode,
    },
    costLogMetadata: {
      role: 'generator',
      agentSlug: GENERATOR_AGENT_SLUG,
      mode: params.mode,
    },
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (result.errorCode) {
    throw new ValidationError(
      `case_generator stream error: ${result.errorCode}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`
    );
  }

  // 3. Parse the JSON envelope.
  const parsed = tryParseJson<{ cases: RawProposedCase[] }>(result.assistantText, (raw) => {
    const r = generatorResponseSchema.safeParse(raw);
    if (!r.success) return null;
    return r.data;
  });
  if (!parsed) {
    logger.warn('case_generator: malformed JSON from generator agent', {
      agentId: params.agentId,
      mode: params.mode,
      preview: result.assistantText.slice(0, 300),
    });
    throw new ValidationError(
      'The case-generator agent returned a malformed response. The generator must emit JSON matching { cases: [{ input, expectedOutput?, metadata? }] }.'
    );
  }

  // Tag every proposed case with the synthesis source so the UI can
  // distinguish synthetic from captured / uploaded cases when the
  // operator browses the dataset later.
  const tagged: ProposedCase[] = parsed.cases.map((c) => {
    const out: ProposedCase = {
      input: c.input,
      metadata: {
        ...(c.metadata ?? {}),
        source: 'synthetic',
        mode: params.mode,
        generatorAgentSlug: GENERATOR_AGENT_SLUG,
        generatedAt: new Date().toISOString(),
      },
    };
    if (c.expectedOutput !== undefined) out.expectedOutput = c.expectedOutput;
    return out;
  });

  logger.info('Synthesised dataset cases', {
    agentId: params.agentId,
    mode: params.mode,
    requested: params.count,
    proposed: tagged.length,
    costUsd: result.costUsd,
  });

  return {
    cases: tagged,
    costUsd: result.costUsd,
    tokenUsage: result.tokenUsage,
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

function buildKbPrompt(chunks: KbSeedChunk[], count: number, topic: string | undefined): string {
  const lines: string[] = [];
  lines.push(`SEED_SOURCE: kb`);
  lines.push(`COUNT: ${count}`);
  if (topic && topic.trim()) lines.push(`TOPIC: ${topic.trim()}`);
  lines.push('');
  lines.push(
    'KB CHUNKS (numbered — your expectedOutput should cite [N] markers where appropriate):'
  );
  chunks.forEach((c, i) => {
    const docLabel = c.documentName ? ` — ${c.documentName}` : '';
    lines.push('');
    lines.push(`[${i + 1}] (${c.chunkType}${docLabel})`);
    lines.push(c.content);
  });
  lines.push('');
  lines.push('Generate exactly the requested COUNT cases as JSON.');
  return lines.join('\n');
}

function buildFailurePrompt(failures: FailureSeed[], count: number): string {
  const lines: string[] = [];
  lines.push(`SEED_SOURCE: failure_mining`);
  lines.push(`COUNT: ${count}`);
  lines.push('');
  lines.push(
    'Prior cases the subject agent under-scored. Generate SIMILAR BUT HARDER variants — same topic, but probe an adjacent concept, a stricter constraint, or an edge case that targets the same failure mode.'
  );
  failures.forEach((f, i) => {
    lines.push('');
    lines.push(`[${i + 1}] score=${f.score.toFixed(2)}`);
    lines.push(`  INPUT: ${f.input}`);
    if (f.expectedOutput) lines.push(`  EXPECTED: ${f.expectedOutput}`);
    if (f.reasoning) lines.push(`  WHY IT FAILED: ${f.reasoning}`);
  });
  lines.push('');
  lines.push('Generate exactly the requested COUNT cases as JSON.');
  return lines.join('\n');
}
