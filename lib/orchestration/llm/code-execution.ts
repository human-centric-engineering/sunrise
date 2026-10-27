/**
 * Costing the provider's own code execution (`ProviderTools.codeExecution`).
 *
 * Neither Anthropic nor OpenAI reports how long a container was billed for,
 * and both state a 5-minute minimum. So each container a reply uses is costed
 * at the larger of its measured run time and that minimum (owner ruling,
 * t-956). A reply can span several calls (a tool loop), and each call is
 * costed on its own, so a call is billed what its runs add to each container:
 * the minimum the first time the reply uses one, then whatever takes the
 * container's total past it.
 *
 * The runs a reply made before this call are on the blocks the tool loop
 * replays (`LlmMessage.reasoning`), which carry each run's container and
 * duration. Nothing is kept between replies, and neither is a container:
 * the next reply starts a new one.
 *
 * Platform-agnostic: no Next.js imports.
 */

import {
  CODE_EXECUTION_MIN_BILLED_SECONDS,
  type CodeExecutionUsage,
  type LlmMessage,
  type LlmReasoningBlock,
} from '@/lib/orchestration/llm/types';

/** One code run: the container it ran in, and how long it ran. */
export interface CodeRun {
  containerId: string;
  durationMs: number;
}

/** The run a block records, when it is a code run's result. */
export function codeRunOf(block: LlmReasoningBlock): CodeRun | undefined {
  if (
    block.type === 'code_execution_tool_result' ||
    block.type === 'openai_code_interpreter_call'
  ) {
    return { containerId: block.containerId, durationMs: block.durationMs };
  }
  return undefined;
}

/** The code runs the reply made before this call, from the turns it replays. */
export function earlierCodeRuns(messages: readonly LlmMessage[]): CodeRun[] {
  return messages.flatMap((message) =>
    (message.reasoning ?? []).flatMap((block) => {
      const run = codeRunOf(block);
      return run ? [run] : [];
    })
  );
}

/**
 * The container the reply's latest Anthropic code run used, to run the next
 * one in. OpenAI's runs are left out: after a fallback their `cntr_…` id
 * means nothing to Anthropic (OpenAI reuses its own from the replayed item).
 */
export function latestContainerId(messages: readonly LlmMessage[]): string | undefined {
  for (let m = messages.length - 1; m >= 0; m--) {
    const blocks = messages[m].reasoning ?? [];
    for (let b = blocks.length - 1; b >= 0; b--) {
      const block = blocks[b];
      if (block.type === 'code_execution_tool_result' && block.containerId)
        return block.containerId;
    }
  }
  return undefined;
}

/**
 * What this call's runs are billed as, given the runs the reply made before
 * it. `undefined` when the call ran no code.
 */
export function billCodeExecution(
  earlier: readonly CodeRun[],
  runs: readonly CodeRun[],
  usdPerHour: number
): CodeExecutionUsage | undefined {
  if (runs.length === 0) return undefined;
  const floorMs = CODE_EXECUTION_MIN_BILLED_SECONDS * 1000;
  const before = totalsByContainer(earlier);
  let billedMs = 0;
  for (const [containerId, ms] of totalsByContainer(runs)) {
    const prior = before.get(containerId);
    billedMs +=
      prior === undefined
        ? Math.max(floorMs, ms)
        : Math.max(floorMs, prior + ms) - Math.max(floorMs, prior);
  }
  return { runs: runs.length, billedSeconds: billedMs / 1000, usdPerHour };
}

function totalsByContainer(runs: readonly CodeRun[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const run of runs) {
    totals.set(run.containerId, (totals.get(run.containerId) ?? 0) + run.durationMs);
  }
  return totals;
}

/** USD for a call's code runs. */
export function codeExecutionCostUsd(usage: CodeExecutionUsage): number {
  return (usage.billedSeconds / 3600) * usage.usdPerHour;
}
