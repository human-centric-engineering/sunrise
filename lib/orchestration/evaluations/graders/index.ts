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

// Model graders — a single registry entry, `judge_agent`, that drives
// any AiAgent with `kind='judge'`. The 6 built-in judges live as
// seeded agents (prisma/seeds/016-evaluation-judges.ts); admins can
// create custom judges via the agent form.
import '@/lib/orchestration/evaluations/graders/model/judge-agent';

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
  // model — one registry slug; the specific judge is picked via
  // config.agentSlug at run time.
  'judge_agent',
] as const;
