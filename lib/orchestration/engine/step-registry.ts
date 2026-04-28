/**
 * Workflow step registry
 *
 * Data-driven catalogue of pattern step types. Both the visual workflow
 * builder palette and (eventually, Session 5.2) the workflow engine read
 * from here rather than hardcoding the list of step kinds.
 *
 * **Adding a new step type:** append an entry below. The palette, the
 * `PatternNode` custom node, and any registry-driven consumer will pick
 * it up automatically. `KNOWN_STEP_TYPES` in `types/orchestration.ts`
 * should stay in sync for autocomplete; the validator still recognises
 * the open `WorkflowStepType` string type.
 *
 * **FE/BE split:** this module is FE-only for Session 5.1a. The backend
 * validator keeps its own `KNOWN_STEP_TYPES` array; Session 5.2 will
 * unify them.
 */

import {
  Bot,
  BrainCircuit,
  ClipboardCheck,
  GitBranch,
  GitFork,
  Globe,
  Link as LinkIcon,
  MessageSquareCode,
  Network,
  Search,
  ShieldCheck,
  Sparkles,
  UserCheck,
  Bell,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { WorkflowStepType } from '@/types/orchestration';

/** Visual category — drives node background colour in the canvas. */
export type StepCategory = 'agent' | 'decision' | 'output' | 'input' | 'orchestration';

export interface StepRegistryEntry {
  /** Matches a `WorkflowStepType` string. */
  type: WorkflowStepType;
  /** Human-readable label shown in the palette and on nodes. */
  label: string;
  /** One-line description shown in the palette tooltip. */
  description: string;
  /** Visual category used for colour coding. */
  category: StepCategory;
  /** Icon displayed in the palette and on the canvas node. */
  icon: LucideIcon;
  /** Number of input handles (target side). */
  inputs: number;
  /** Number of output handles (source side). */
  outputs: number;
  /** Human-readable labels for each output handle (when outputs > 1). */
  outputLabels?: string[];
  /** Optional pattern number for the "Learn more" forward-link. */
  patternNumber?: number;
  /** Seed config applied when a new block is dropped on the canvas. */
  defaultConfig: Record<string, unknown>;
  /** Approximate execution time hint shown in the palette. */
  estimatedDuration: string;
}

export const STEP_REGISTRY: readonly StepRegistryEntry[] = [
  {
    type: 'llm_call',
    label: 'LLM Call',
    description: 'A single model call — the basic unit of a workflow.',
    category: 'agent',
    icon: Sparkles,
    inputs: 1,
    outputs: 1,
    patternNumber: 1,
    defaultConfig: { prompt: '', modelOverride: '', temperature: 0.7 },
    estimatedDuration: '~2-5s',
  },
  {
    type: 'chain',
    label: 'Chain Step',
    description: 'Sequential LLM call with a validation gate.',
    category: 'agent',
    icon: LinkIcon,
    inputs: 1,
    outputs: 1,
    patternNumber: 1,
    defaultConfig: { steps: [] },
    estimatedDuration: '~5-15s',
  },
  {
    type: 'route',
    label: 'Route',
    description: 'Classify input and branch to different paths.',
    category: 'decision',
    icon: GitBranch,
    inputs: 1,
    outputs: 2,
    patternNumber: 2,
    defaultConfig: { classificationPrompt: '', routes: [] },
    estimatedDuration: '~1-3s',
  },
  {
    type: 'parallel',
    label: 'Parallel',
    description: 'Fan out to concurrent branches and join the results.',
    category: 'decision',
    icon: GitFork,
    inputs: 1,
    outputs: 3,
    patternNumber: 3,
    defaultConfig: { branches: [], timeoutMs: 60000, stragglerStrategy: 'wait-all' },
    estimatedDuration: 'varies',
  },
  {
    type: 'reflect',
    label: 'Reflect',
    description: 'Draft → critique → revise loop for higher quality output.',
    category: 'agent',
    icon: MessageSquareCode,
    inputs: 1,
    outputs: 1,
    patternNumber: 4,
    defaultConfig: { critiquePrompt: '', maxIterations: 3 },
    estimatedDuration: '~10-30s',
  },
  {
    type: 'tool_call',
    label: 'Tool Call',
    description: 'Execute a registered capability.',
    category: 'input',
    icon: Wrench,
    inputs: 1,
    outputs: 1,
    patternNumber: 5,
    defaultConfig: { capabilitySlug: '' },
    estimatedDuration: '~0.5-2s',
  },
  {
    type: 'plan',
    label: 'Plan',
    description: 'Agent generates its own sub-plan before executing.',
    category: 'agent',
    icon: BrainCircuit,
    inputs: 1,
    outputs: 1,
    patternNumber: 6,
    defaultConfig: { objective: '', maxSubSteps: 5 },
    estimatedDuration: '~5-15s',
  },
  {
    type: 'human_approval',
    label: 'Human Approval',
    description: 'Pause the workflow and wait for human review.',
    category: 'decision',
    icon: UserCheck,
    inputs: 1,
    outputs: 1,
    patternNumber: 13,
    defaultConfig: { prompt: '', timeoutMinutes: 60, notificationChannel: 'in-app' },
    estimatedDuration: 'manual',
  },
  {
    type: 'rag_retrieve',
    label: 'RAG Retrieve',
    description: 'Search the knowledge base for relevant context.',
    category: 'input',
    icon: Search,
    inputs: 1,
    outputs: 1,
    patternNumber: 14,
    defaultConfig: { query: '', topK: 5, similarityThreshold: 0.7 },
    estimatedDuration: '~1-3s',
  },
  {
    type: 'guard',
    label: 'Guard',
    description: 'Validate input or output against safety rules. Pass or fail.',
    category: 'decision',
    icon: ShieldCheck,
    inputs: 1,
    outputs: 2,
    patternNumber: 18,
    defaultConfig: { rules: '', mode: 'llm', failAction: 'block', temperature: 0.1 },
    estimatedDuration: '~1-3s',
  },
  {
    type: 'evaluate',
    label: 'Evaluate',
    description: 'Score output quality against a rubric.',
    category: 'decision',
    icon: ClipboardCheck,
    inputs: 1,
    outputs: 1,
    patternNumber: 19,
    defaultConfig: { rubric: '', scaleMin: 1, scaleMax: 5, threshold: 3 },
    estimatedDuration: '~2-5s',
  },
  {
    type: 'external_call',
    label: 'External Call',
    description: 'Call an external HTTP endpoint or agent.',
    category: 'input',
    icon: Globe,
    inputs: 1,
    outputs: 1,
    patternNumber: 15,
    defaultConfig: { url: '', method: 'POST', timeoutMs: 30000, authType: 'none' },
    estimatedDuration: '~1-10s',
  },
  {
    type: 'agent_call',
    label: 'Agent Call',
    description: 'Invoke a configured agent with its full system prompt, model, and tools.',
    category: 'agent',
    icon: Bot,
    inputs: 1,
    outputs: 1,
    patternNumber: 8,
    defaultConfig: { agentSlug: '', message: '{{input}}', maxToolIterations: 5 },
    estimatedDuration: '~3-15s',
  },
  {
    type: 'send_notification',
    label: 'Send Notification',
    description: 'Send an email or webhook notification with templated content.',
    category: 'output',
    icon: Bell,
    inputs: 1,
    outputs: 1,
    defaultConfig: {
      channel: 'email',
      to: '',
      subject: '',
      bodyTemplate: '{{input}}',
    },
    estimatedDuration: '~1-3s',
  },
  {
    type: 'orchestrator',
    label: 'Orchestrator',
    description: 'AI planner dynamically delegates tasks to agents and synthesizes results.',
    category: 'orchestration',
    icon: Network,
    inputs: 1,
    outputs: 1,
    defaultConfig: {
      plannerPrompt: '',
      availableAgentSlugs: [],
      selectionMode: 'auto',
      maxRounds: 3,
      maxDelegationsPerRound: 5,
      timeoutMs: 120000,
    },
    estimatedDuration: '~30-120s',
  },
] as const;

/** Look up a registry entry by step type. Returns undefined for unknown types. */
export function getStepMetadata(type: WorkflowStepType): StepRegistryEntry | undefined {
  return STEP_REGISTRY.find((entry) => entry.type === type);
}

/**
 * Compute outputs and labels for a step, accounting for dynamic config.
 *
 * Guard steps always have 2 outputs (Pass / Fail). Route and parallel
 * steps derive their output count from `config.routes` / `config.branches`
 * respectively; all other types use the registry defaults.
 */
export function getStepOutputs(
  type: WorkflowStepType,
  config: Record<string, unknown>
): { outputs: number; outputLabels?: string[] } {
  if (type === 'guard') {
    return { outputs: 2, outputLabels: ['Pass', 'Fail'] };
  }

  if (type === 'route') {
    const routes = Array.isArray(config.routes) ? config.routes : [];
    if (routes.length > 0) {
      return {
        outputs: routes.length,
        outputLabels: routes.map((r: unknown, i: number) => {
          const obj = r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
          const label = obj && typeof obj.label === 'string' ? obj.label : '';
          return label || `Branch ${i + 1}`;
        }),
      };
    }
  }

  if (type === 'parallel') {
    const branches = Array.isArray(config.branches) ? config.branches : [];
    if (branches.length > 0) {
      return {
        outputs: branches.length,
        outputLabels: branches.map((_: unknown, i: number) => `Branch ${i + 1}`),
      };
    }
  }

  const meta = getStepMetadata(type);
  return { outputs: meta?.outputs ?? 1, outputLabels: meta?.outputLabels };
}

/** Ordered list of categories for grouping in the palette. */
export const STEP_CATEGORY_ORDER: readonly StepCategory[] = [
  'orchestration',
  'agent',
  'decision',
  'input',
  'output',
] as const;

/** Human-readable category labels shown as section headers in the palette. */
export const STEP_CATEGORY_LABELS: Record<StepCategory, string> = {
  orchestration: 'Orchestration',
  agent: 'Agents',
  decision: 'Decisions',
  input: 'Inputs',
  output: 'Outputs',
};

/** Tailwind classes per category used by `PatternNode` and palette chips. */
export const STEP_CATEGORY_COLOURS: Record<
  StepCategory,
  { bg: string; border: string; text: string; iconBg: string }
> = {
  orchestration: {
    bg: 'bg-purple-50 dark:bg-purple-950/40',
    border: 'border-purple-300 dark:border-purple-800',
    text: 'text-purple-900 dark:text-purple-100',
    iconBg: 'bg-purple-100 dark:bg-purple-900/60',
  },
  agent: {
    bg: 'bg-blue-50 dark:bg-blue-950/40',
    border: 'border-blue-300 dark:border-blue-800',
    text: 'text-blue-900 dark:text-blue-100',
    iconBg: 'bg-blue-100 dark:bg-blue-900/60',
  },
  decision: {
    bg: 'bg-amber-50 dark:bg-amber-950/40',
    border: 'border-amber-300 dark:border-amber-800',
    text: 'text-amber-900 dark:text-amber-100',
    iconBg: 'bg-amber-100 dark:bg-amber-900/60',
  },
  output: {
    bg: 'bg-emerald-50 dark:bg-emerald-950/40',
    border: 'border-emerald-300 dark:border-emerald-800',
    text: 'text-emerald-900 dark:text-emerald-100',
    iconBg: 'bg-emerald-100 dark:bg-emerald-900/60',
  },
  input: {
    bg: 'bg-slate-50 dark:bg-slate-900/60',
    border: 'border-slate-300 dark:border-slate-700',
    text: 'text-slate-900 dark:text-slate-100',
    iconBg: 'bg-slate-200 dark:bg-slate-800',
  },
};
