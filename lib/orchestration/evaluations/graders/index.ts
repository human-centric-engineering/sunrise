/**
 * Grader registry barrel.
 *
 * Imports every grader module so each one's top-level `registerGrader`
 * call fires at startup. Adding a new grader is one new file plus one
 * import line here.
 *
 * Order matters: this is the order they appear in the run-creation
 * metric picker. Heuristic graders first (cheap, always safe to add),
 * then model graders (cost spend), then pairwise (Phase 3).
 */

// Heuristic graders
import '@/lib/orchestration/evaluations/graders/heuristic/exact-match';
import '@/lib/orchestration/evaluations/graders/heuristic/contains';
import '@/lib/orchestration/evaluations/graders/heuristic/regex';
import '@/lib/orchestration/evaluations/graders/heuristic/length-between';
import '@/lib/orchestration/evaluations/graders/heuristic/json-schema';
import '@/lib/orchestration/evaluations/graders/heuristic/json-path-equals';
import '@/lib/orchestration/evaluations/graders/heuristic/tool-was-called';
import '@/lib/orchestration/evaluations/graders/heuristic/citation-count-at-least';

// Model graders — `judge_agent` drives any AiAgent with `kind='judge'`
// (the built-in judges are platform agents, defined in
// lib/orchestration/agents/platform-agent-definitions/; admins can create custom
// judges via the agent form). `workflow_as_judge` drives an entire
// workflow as a judge — Phase 3.
import '@/lib/orchestration/evaluations/graders/model/judge-agent';
import '@/lib/orchestration/evaluations/graders/model/workflow-as-judge';

// Pairwise graders — judge agent shown two outputs side-by-side
// picks a winner. Used by the experiment compare view's verdict badge.
import '@/lib/orchestration/evaluations/graders/pairwise/judge-agent';

export * from '@/lib/orchestration/evaluations/graders/types';
export {
  registerGrader,
  getGrader,
  getPairwiseGrader,
  hasGrader,
  listGraders,
  getRegisteredSlugs,
  __resetGraderRegistryForTests,
} from '@/lib/orchestration/evaluations/graders/registry';

/**
 * Canonical list of slugs the registry MUST contain after barrel import.
 * The parity test in `__tests__/registry-parity.test.ts` asserts this.
 * Update both this list and the barrel imports above when adding/
 * removing a grader.
 */
export const KNOWN_GRADER_SLUGS = [
  // heuristic
  'exact_match',
  'contains',
  'regex',
  'length_between',
  'json_schema',
  'json_path_equals',
  'tool_was_called',
  'citation_count_at_least',
  // model — judge_agent picks the specific judge via config.agentSlug.
  // workflow_as_judge drives an AiWorkflow as the judge.
  'judge_agent',
  'workflow_as_judge',
  // pairwise — judge agent shown two outputs picks a winner.
  'pairwise_judge_agent',
] as const;
