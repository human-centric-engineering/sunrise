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
  BrainCircuit,
  GitBranch,
  GitFork,
  Link as LinkIcon,
  MessageSquareCode,
  Search,
  Sparkles,
  UserCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

import type { WorkflowStepType } from '@/types/orchestration';

/** Visual category — drives node background colour in the canvas. */
export type StepCategory = 'agent' | 'decision' | 'output' | 'input';

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
  /** Optional pattern number for the "Learn more" forward-link. */
  patternNumber?: number;
  /** Seed config applied when a new block is dropped on the canvas. */
  defaultConfig: Record<string, unknown>;
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
  },
  {
    type: 'chain',
    label: 'Chain Step',
    description: 'Sequential LLM call with a validation gate.',
    category: 'agent',
    icon: LinkIcon,
    inputs: 1,
    outputs: 1,
    patternNumber: 2,
    defaultConfig: { steps: [] },
  },
  {
    type: 'route',
    label: 'Route',
    description: 'Classify input and branch to different paths.',
    category: 'decision',
    icon: GitBranch,
    inputs: 1,
    outputs: 2,
    patternNumber: 3,
    defaultConfig: { classificationPrompt: '', routes: [] },
  },
  {
    type: 'parallel',
    label: 'Parallel',
    description: 'Fan out to concurrent branches and join the results.',
    category: 'output',
    icon: GitFork,
    inputs: 1,
    outputs: 3,
    patternNumber: 4,
    defaultConfig: { branches: [], timeoutMs: 60000, stragglerStrategy: 'wait-all' },
  },
  {
    type: 'reflect',
    label: 'Reflect',
    description: 'Draft → critique → revise loop for higher quality output.',
    category: 'agent',
    icon: MessageSquareCode,
    inputs: 1,
    outputs: 1,
    patternNumber: 5,
    defaultConfig: { critiquePrompt: '', maxIterations: 3 },
  },
  {
    type: 'tool_call',
    label: 'Tool Call',
    description: 'Execute a registered capability.',
    category: 'input',
    icon: Wrench,
    inputs: 1,
    outputs: 1,
    patternNumber: 6,
    defaultConfig: { capabilitySlug: '' },
  },
  {
    type: 'plan',
    label: 'Plan',
    description: 'Agent generates its own sub-plan before executing.',
    category: 'agent',
    icon: BrainCircuit,
    inputs: 1,
    outputs: 1,
    patternNumber: 7,
    defaultConfig: { objective: '', maxSubSteps: 5 },
  },
  {
    type: 'human_approval',
    label: 'Human Approval',
    description: 'Pause the workflow and wait for human review.',
    category: 'decision',
    icon: UserCheck,
    inputs: 1,
    outputs: 1,
    patternNumber: 8,
    defaultConfig: { prompt: '', timeoutMinutes: 60, notificationChannel: 'in-app' },
  },
  {
    type: 'rag_retrieve',
    label: 'RAG Retrieve',
    description: 'Search the knowledge base for relevant context.',
    category: 'input',
    icon: Search,
    inputs: 1,
    outputs: 1,
    patternNumber: 9,
    defaultConfig: { query: '', topK: 5, similarityThreshold: 0.7 },
  },
] as const;

/** Look up a registry entry by step type. Returns undefined for unknown types. */
export function getStepMetadata(type: WorkflowStepType): StepRegistryEntry | undefined {
  return STEP_REGISTRY.find((entry) => entry.type === type);
}

/** Ordered list of categories for grouping in the palette. */
export const STEP_CATEGORY_ORDER: readonly StepCategory[] = [
  'agent',
  'decision',
  'input',
  'output',
] as const;

/** Human-readable category labels shown as section headers in the palette. */
export const STEP_CATEGORY_LABELS: Record<StepCategory, string> = {
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
