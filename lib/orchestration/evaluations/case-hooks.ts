/**
 * Per-agent eval case hooks — set a case up before the subject's turn, and
 * read back what its tools changed after it (#879).
 *
 * A dataset eval of an agent whose job is to change things through its tools
 * has to start each case from a known state and grade what the tools left
 * behind, not only the reply. A fork registers, per agent:
 *
 *   • `setup` — runs fresh before every case. It seeds or resets the state the
 *     case starts from, and returns the chat context fields the turn should
 *     carry (`contextType`, `contextId`, `entityContext`, `scope`), the same
 *     ones a real chat turn carries. Every case runs as the run's user, so this
 *     is where per-user state a tool keeps is reset between cases.
 *   • `observe` — runs after the turn and returns whatever the graders should
 *     see of the resulting state. Graders receive it as `observed`.
 *
 * Both run inside the run's org context (the worker is a per-org job), so a
 * hook reads its org with `requireOrgId()` as other job code does.
 *
 * A hook that throws — or a `setup` that returns anything but the four fields
 * — fails that case only, with `case_setup_failed` or `case_observe_failed`;
 * its graders are skipped as on a subject error, and the run goes on. An agent
 * with no hooks is run exactly as before.
 *
 * Registered from `lib/app/evaluations.ts` → `initAppEvalCaseHooks()`, which
 * runs once, lazily, before the first lookup (`lib/fork-init.ts`), so it runs
 * in the realm the worker does.
 *
 * @see .context/orchestration/evaluations.md — "Setting up and observing a case"
 */

import { z } from 'zod';
import { initAppEvalCaseHooks } from '@/lib/app/evaluations';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { logger } from '@/lib/logging';
import type { GraderToolCall } from '@/lib/orchestration/evaluations/graders/types';

/** The dataset case a hook is run for. */
export interface EvalCaseRow {
  id: string;
  position: number;
  input: unknown;
  expectedOutput: string | null;
  metadata: unknown;
}

/** What every hook is told about the case it runs for. */
export interface EvalCaseHookArgs {
  agentSlug: string;
  /** The user the run — and so the subject's turn — runs as. */
  userId: string;
  /** The evaluation run, for a hook that names what it seeds. */
  runId: string;
  caseRow: EvalCaseRow;
}

/** What the subject's turn produced, for `observe`. */
export interface EvalCaseTurn {
  /** The conversation the turn wrote to, when the stream reported one. */
  conversationId?: string;
  assistantText: string;
  toolCalls: GraderToolCall[];
}

/** The chat context fields `setup` may give the subject's turn. */
export interface EvalCaseContext {
  contextType?: string;
  contextId?: string;
  entityContext?: Record<string, unknown>;
  scope?: Record<string, string>;
}

export interface EvalCaseHooks {
  setup?: (args: EvalCaseHookArgs) => EvalCaseContext | void | Promise<EvalCaseContext | void>;
  observe?: (args: EvalCaseHookArgs & { turn: EvalCaseTurn }) => unknown;
}

/**
 * `setup`'s answer, checked: a fork's JavaScript can return anything, and an
 * unknown key (`conversationId`, a typo) is refused rather than dropped, so the
 * case fails loudly instead of running without the context it was meant to.
 */
const evalCaseContextSchema = z
  .object({
    contextType: z.string().min(1).optional(),
    contextId: z.string().min(1).optional(),
    entityContext: z.record(z.string(), z.unknown()).optional(),
    scope: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** Parse `setup`'s answer; `undefined` (no context) is `{}`. Throws on anything else. */
export function parseEvalCaseContext(value: unknown): EvalCaseContext {
  if (value === undefined) return {};
  const parsed = evalCaseContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `setup returned an invalid context: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

const hooksByAgent = new Map<string, EvalCaseHooks>();

const appInit = createAppInitGate({
  label: 'eval-case-hooks: initAppEvalCaseHooks',
  subject: 'app eval case hooks',
  init: initAppEvalCaseHooks,
  snapshot: () => new Map(hooksByAgent),
  restore: (before) => restoreMap(hooksByAgent, before),
});

/**
 * Register `setup` and/or `observe` for the agent with this slug. Call from
 * `initAppEvalCaseHooks()` in `lib/app/evaluations.ts`. Registering the same
 * slug again replaces its hooks, with a warning.
 */
export function registerEvalCaseHooks(agentSlug: string, hooks: EvalCaseHooks): void {
  const slug = agentSlug.trim();
  if (slug === '') throw new Error('registerEvalCaseHooks: agentSlug is empty');
  const setup: unknown = hooks.setup;
  const observe: unknown = hooks.observe;
  if (setup !== undefined && typeof setup !== 'function') {
    throw new Error(`registerEvalCaseHooks(${slug}): setup is not a function`);
  }
  if (observe !== undefined && typeof observe !== 'function') {
    throw new Error(`registerEvalCaseHooks(${slug}): observe is not a function`);
  }
  if (setup === undefined && observe === undefined) {
    throw new Error(`registerEvalCaseHooks(${slug}): give it a setup, an observe, or both`);
  }
  if (hooksByAgent.has(slug)) {
    logger.warn('registerEvalCaseHooks: replacing the hooks already registered', {
      agentSlug: slug,
    });
  }
  hooksByAgent.set(slug, { ...hooks });
}

/** The hooks registered for this agent, or `null`. */
export function evalCaseHooksFor(agentSlug: string): EvalCaseHooks | null {
  appInit.ensure();
  return hooksByAgent.get(agentSlug) ?? null;
}

/** The slugs of the agents with hooks registered, sorted. */
export function registeredEvalCaseHookAgents(): string[] {
  appInit.ensure();
  return [...hooksByAgent.keys()].sort();
}

/** Test-only: clear the registry and re-arm the one-shot init. */
export function __resetEvalCaseHooksForTests(): void {
  hooksByAgent.clear();
  appInit.reset();
}
