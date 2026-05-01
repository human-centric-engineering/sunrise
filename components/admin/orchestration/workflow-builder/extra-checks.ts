/**
 * FE-only supplementary validation for the workflow builder.
 *
 * `validateWorkflow` in `lib/orchestration/workflows/validator.ts` is the
 * authoritative backend-aligned check (duplicate ids, unreachable steps,
 * cycles, missing approval prompts, missing capability slugs). These extra
 * checks run _alongside_ it in the builder UI to catch failure modes the
 * backend validator doesn't yet model — they will migrate to the backend
 * in Session 5.2 when the step registry is unified.
 *
 * Error shape mirrors `WorkflowValidationError` so the summary panel can
 * merge both lists without special-casing the source.
 */
import type { Edge } from '@xyflow/react';

import type { PatternNode } from '@/components/admin/orchestration/workflow-builder/workflow-mappers';

/**
 * Structured error, shape-compatible with `WorkflowValidationError`.
 *
 * `code` is the FE-only extension; UI renders the same red ring + summary
 * row regardless of which validator flagged it.
 */
export interface ExtraCheckError {
  code:
    | 'DISCONNECTED_NODE'
    | 'PARALLEL_WITHOUT_MERGE'
    | 'MISSING_REQUIRED_CONFIG'
    | 'CYCLE_DETECTED'
    | 'DANGLING_EDGE';
  message: string;
  stepId?: string;
}

/**
 * Run all extra builder-side checks over the current React Flow state.
 *
 * Called by the builder shell on every debounced change — so this must be
 * cheap. All loops are O(N+E) with no heavy allocations.
 */
export function runExtraChecks(
  nodes: readonly PatternNode[],
  edges: readonly Edge[]
): ExtraCheckError[] {
  const errors: ExtraCheckError[] = [];
  errors.push(...checkDisconnected(nodes, edges));
  errors.push(...checkParallelMerges(nodes, edges));
  errors.push(...checkRequiredConfig(nodes));
  errors.push(...checkCycles(nodes, edges));
  errors.push(...checkDanglingEdges(nodes, edges));
  return errors;
}

// ---------------------------------------------------------------------------
// DISCONNECTED_NODE
// ---------------------------------------------------------------------------

/**
 * A non-entry node with zero incoming AND zero outgoing edges is orphaned.
 *
 * "Entry" is the first node in the list that has no incoming edge — this
 * mirrors the entry-step heuristic in `flowToWorkflowDefinition`. The entry
 * node itself is exempt because a freshly-dropped workflow with one LLM
 * Call is a legitimate state the user should be allowed to save.
 */
function checkDisconnected(
  nodes: readonly PatternNode[],
  edges: readonly Edge[]
): ExtraCheckError[] {
  if (nodes.length === 0) return [];

  const incoming = new Set(edges.map((e) => e.target));
  const outgoing = new Set(edges.map((e) => e.source));
  const entryId = nodes.find((n) => !incoming.has(n.id))?.id ?? nodes[0]?.id;

  const errors: ExtraCheckError[] = [];
  for (const node of nodes) {
    if (node.id === entryId) continue;
    if (!incoming.has(node.id) && !outgoing.has(node.id)) {
      errors.push({
        code: 'DISCONNECTED_NODE',
        message: `Step "${node.data.label}" is not connected to the workflow`,
        stepId: node.id,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// PARALLEL_WITHOUT_MERGE
// ---------------------------------------------------------------------------

/**
 * A `parallel` step fans out to N branches; every branch should reconverge
 * at the same downstream node for the executor's join semantics to be
 * well-defined. We detect divergence by BFS'ing forward from each branch
 * and flagging the parallel if the branch-reachable sets have no common
 * non-branch-root node.
 *
 * This is intentionally conservative: a parallel with a single outgoing
 * edge (which the user may not have finished wiring yet) is **not** flagged
 * — the `DISCONNECTED_NODE` / core reachability checks cover that case.
 */
function checkParallelMerges(
  nodes: readonly PatternNode[],
  edges: readonly Edge[]
): ExtraCheckError[] {
  const errors: ExtraCheckError[] = [];
  const outgoingByNode = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoingByNode.get(edge.source) ?? [];
    list.push(edge.target);
    outgoingByNode.set(edge.source, list);
  }

  for (const node of nodes) {
    if (node.data.type !== 'parallel') continue;
    const branchRoots = outgoingByNode.get(node.id) ?? [];
    if (branchRoots.length < 2) continue;

    // BFS forward from each branch root, collecting the set of reachable
    // nodes (excluding the branch root itself, which trivially sits in its
    // own set and would defeat the intersection test).
    const reachableSets = branchRoots.map((root) => {
      const seen = new Set<string>();
      const queue: string[] = [root];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const next of outgoingByNode.get(current) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return seen;
    });

    // The branches converge iff the intersection of all reachable sets is
    // non-empty.
    const [first, ...rest] = reachableSets;
    const intersection = new Set<string>(first);
    for (const set of rest) {
      for (const id of intersection) {
        if (!set.has(id)) intersection.delete(id);
      }
    }

    if (intersection.size === 0) {
      errors.push({
        code: 'PARALLEL_WITHOUT_MERGE',
        message: `Parallel step "${node.data.label}" has branches that never merge`,
        stepId: node.id,
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// MISSING_REQUIRED_CONFIG
// ---------------------------------------------------------------------------

/**
 * Per-step-type required-config emptiness checks.
 *
 * Some of these (`human_approval` prompt, `tool_call` capabilitySlug) are
 * already enforced by the backend validator. Duplicating them here means
 * the red ring + summary row appear instantly instead of only when the
 * user hits Save.
 */
function checkRequiredConfig(nodes: readonly PatternNode[]): ExtraCheckError[] {
  const errors: ExtraCheckError[] = [];
  for (const node of nodes) {
    const { type, config, label } = node.data as PatternNode['data'] & { label: string };
    const emit = (message: string): void => {
      errors.push({ code: 'MISSING_REQUIRED_CONFIG', message, stepId: node.id });
    };

    switch (type) {
      case 'llm_call': {
        if (!isNonEmptyString(config.prompt)) {
          emit(`LLM Call "${label}" needs a prompt template`);
        }
        break;
      }
      case 'tool_call': {
        if (!isNonEmptyString(config.capabilitySlug)) {
          emit(`Tool Call "${label}" needs a selected capability`);
        }
        break;
      }
      case 'human_approval': {
        if (!isNonEmptyString(config.prompt)) {
          emit(`Human Approval "${label}" needs an approval message`);
        }
        break;
      }
      case 'rag_retrieve': {
        if (!isNonEmptyString(config.query)) {
          emit(`RAG Retrieve "${label}" needs a search query`);
        }
        break;
      }
      case 'plan': {
        if (!isNonEmptyString(config.objective)) {
          emit(`Plan "${label}" needs an objective`);
        }
        break;
      }
      case 'reflect': {
        if (!isNonEmptyString(config.critiquePrompt)) {
          emit(`Reflect "${label}" needs a critique prompt`);
        }
        break;
      }
      case 'route': {
        if (!isNonEmptyString(config.classificationPrompt)) {
          emit(`Route "${label}" needs a classification prompt`);
        }
        const routes = Array.isArray(config.routes) ? config.routes : [];
        if (routes.length < 2) {
          emit(`Route "${label}" needs at least two branches`);
        }
        break;
      }
      case 'guard': {
        if (!isNonEmptyString(config.rules)) {
          emit(`Guard "${label}" needs safety rules`);
        }
        break;
      }
      case 'evaluate': {
        if (!isNonEmptyString(config.rubric)) {
          emit(`Evaluate "${label}" needs a scoring rubric`);
        }
        break;
      }
      case 'external_call': {
        if (!isNonEmptyString(config.url)) {
          emit(`External Call "${label}" needs a target URL`);
        }
        break;
      }
      case 'orchestrator': {
        if (!isNonEmptyString(config.plannerPrompt)) {
          emit(`Orchestrator "${label}" needs a planner prompt`);
        }
        const slugs = Array.isArray(config.availableAgentSlugs) ? config.availableAgentSlugs : [];
        if (slugs.length === 0) {
          emit(`Orchestrator "${label}" needs at least one available agent`);
        }
        break;
      }
      case 'agent_call': {
        if (!isNonEmptyString(config.agentSlug)) {
          emit(`Agent Call "${label}" needs a selected agent`);
        }
        if (!isNonEmptyString(config.message)) {
          emit(`Agent Call "${label}" needs a message template`);
        }
        break;
      }
      case 'send_notification': {
        const channel = config.channel as string | undefined;
        if (!isNonEmptyString(config.bodyTemplate)) {
          emit(`Notification "${label}" needs a body template`);
        }
        if (channel === 'email' && !isNonEmptyString(config.to)) {
          emit(`Notification "${label}" (email) needs recipients`);
        }
        if (channel === 'webhook' && !isNonEmptyString(config.webhookUrl)) {
          emit(`Notification "${label}" (webhook) needs a URL`);
        }
        break;
      }
      default:
        // chain / parallel have no required config.
        break;
    }
  }
  return errors;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// CYCLE_DETECTED
// ---------------------------------------------------------------------------

/**
 * Lightweight DFS cycle detection on the React Flow graph so users get
 * instant feedback instead of waiting for the backend validator on save.
 */
function checkCycles(nodes: readonly PatternNode[], edges: readonly Edge[]): ExtraCheckError[] {
  // Build adjacency list with retry metadata so bounded back-edges
  // can be distinguished from unbounded cycles.
  interface AdjEntry {
    target: string;
    maxRetries?: number;
    condition?: string;
  }
  const adj = new Map<string, AdjEntry[]>();
  for (const edge of edges) {
    const list = adj.get(edge.source) ?? [];
    const data = edge.data;
    list.push({
      target: edge.target,
      maxRetries: typeof data?.maxRetries === 'number' ? data.maxRetries : undefined,
      condition: typeof edge.label === 'string' ? edge.label : undefined,
    });
    adj.set(edge.source, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const node of nodes) colour.set(node.id, WHITE);

  const errors: ExtraCheckError[] = [];
  const reported = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    colour.set(id, GRAY);
    stack.push(id);
    for (const entry of adj.get(id) ?? []) {
      const c = colour.get(entry.target) ?? WHITE;
      if (c === GRAY) {
        // Bounded retry edges with a condition are allowed.
        if (entry.maxRetries && entry.maxRetries > 0 && entry.condition) {
          continue;
        }
        if (!reported.has(entry.target)) {
          reported.add(entry.target);
          const cycleStart = stack.indexOf(entry.target);
          const cyclePath = cycleStart >= 0 ? stack.slice(cycleStart) : [entry.target];
          errors.push({
            code: 'CYCLE_DETECTED',
            message: `Cycle detected: ${cyclePath.join(' → ')} → ${entry.target}`,
            stepId: entry.target,
          });
        }
      } else if (c === WHITE) {
        visit(entry.target, stack);
      }
    }
    stack.pop();
    colour.set(id, BLACK);
  };

  for (const node of nodes) {
    if ((colour.get(node.id) ?? WHITE) === WHITE) {
      visit(node.id, []);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// DANGLING_EDGE
// ---------------------------------------------------------------------------

/**
 * Edges whose target no longer exists in the node set. React Flow can
 * leave these behind after node deletion. `flowToWorkflowDefinition`
 * silently filters them, but the user should know.
 */
function checkDanglingEdges(
  nodes: readonly PatternNode[],
  edges: readonly Edge[]
): ExtraCheckError[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  return edges
    .filter((e) => !nodeIds.has(e.target) || !nodeIds.has(e.source))
    .map((e) => ({
      code: 'DANGLING_EDGE' as const,
      message: `An edge references a step that no longer exists`,
      stepId: nodeIds.has(e.source) ? e.source : e.target,
    }));
}
