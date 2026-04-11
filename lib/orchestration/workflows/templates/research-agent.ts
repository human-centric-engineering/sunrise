/**
 * Recipe 4: Autonomous Research Agent
 *
 * Patterns: Planning (6) + RAG (14) + Parallelisation (3) + Multi-Agent-style
 * specialists (7) + Reflection (4).
 *
 * Flow: plan the investigation → retrieve prior art from the knowledge
 * base → fan out to three specialist LLM calls (history, current state,
 * future outlook) → synthesise → reflect on the quality of the final
 * report.
 */

import type { WorkflowTemplate } from './types';

export const RESEARCH_AGENT_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-research-agent',
  name: 'Autonomous Research Agent',
  shortDescription:
    'Plans an investigation, retrieves prior art, runs three specialist LLMs in parallel, and synthesises a reflected-on report.',
  patterns: [
    { number: 3, name: 'Parallelisation' },
    { number: 4, name: 'Reflection' },
    { number: 6, name: 'Planning' },
    { number: 7, name: 'Multi-Agent' },
    { number: 14, name: 'RAG' },
  ],
  flowSummary:
    'A Plan step produces a research plan, a RAG Retrieve step pulls relevant prior art from the knowledge base, a Parallel step fans out to three specialist LLM calls (history, current state, future outlook), their outputs converge at a synthesis LLM call, and a Reflect step checks the report before it is returned.',
  workflowDefinition: {
    entryStepId: 'plan_research',
    errorStrategy: 'retry',
    steps: [
      {
        id: 'plan_research',
        name: 'Plan the investigation',
        type: 'plan',
        config: {
          objective:
            'Produce a research plan that identifies the key questions to answer, the sources to consult, and the deliverable format.',
          maxSubSteps: 5,
        },
        nextSteps: [{ targetStepId: 'retrieve_priors' }],
      },
      {
        id: 'retrieve_priors',
        name: 'Retrieve prior art',
        type: 'rag_retrieve',
        config: {
          query: '{{plan_research.output}}',
          topK: 8,
          similarityThreshold: 0.65,
        },
        nextSteps: [{ targetStepId: 'fanout' }],
      },
      {
        id: 'fanout',
        name: 'Specialists in parallel',
        type: 'parallel',
        config: {
          branches: ['specialist_history', 'specialist_current', 'specialist_future'],
          timeoutMs: 90000,
          stragglerStrategy: 'wait-all',
        },
        nextSteps: [
          { targetStepId: 'specialist_history' },
          { targetStepId: 'specialist_current' },
          { targetStepId: 'specialist_future' },
        ],
      },
      {
        id: 'specialist_history',
        name: 'Historical specialist',
        type: 'llm_call',
        config: {
          prompt:
            'You are a historical analyst. Given the research plan and retrieved context, summarise how this topic has evolved over time.\n\nPlan:\n{{plan_research.output}}\n\nContext:\n{{retrieve_priors.output}}',
          modelOverride: '',
          temperature: 0.4,
        },
        nextSteps: [{ targetStepId: 'synthesize' }],
      },
      {
        id: 'specialist_current',
        name: 'Current-state specialist',
        type: 'llm_call',
        config: {
          prompt:
            'You are an analyst of the current state of the field. Summarise the state of the art and open questions using the plan and retrieved context.\n\nPlan:\n{{plan_research.output}}\n\nContext:\n{{retrieve_priors.output}}',
          modelOverride: '',
          temperature: 0.4,
        },
        nextSteps: [{ targetStepId: 'synthesize' }],
      },
      {
        id: 'specialist_future',
        name: 'Future-outlook specialist',
        type: 'llm_call',
        config: {
          prompt:
            'You are a forward-looking analyst. Project likely developments over the next 1–3 years based on the plan and retrieved context.\n\nPlan:\n{{plan_research.output}}\n\nContext:\n{{retrieve_priors.output}}',
          modelOverride: '',
          temperature: 0.5,
        },
        nextSteps: [{ targetStepId: 'synthesize' }],
      },
      {
        id: 'synthesize',
        name: 'Synthesise report',
        type: 'llm_call',
        config: {
          prompt:
            'Merge the three specialist reports below into one cohesive research report with sections for Past, Present, and Future. Cite source chunks when useful.\n\nHistorical:\n{{specialist_history.output}}\n\nCurrent:\n{{specialist_current.output}}\n\nFuture:\n{{specialist_future.output}}',
          modelOverride: '',
          temperature: 0.5,
        },
        nextSteps: [{ targetStepId: 'quality_check' }],
      },
      {
        id: 'quality_check',
        name: 'Reflect on quality',
        type: 'reflect',
        config: {
          critiquePrompt:
            'Critique the synthesised report for coverage gaps, unsupported claims, and structure. Revise until no further critique is needed.',
          maxIterations: 3,
        },
        nextSteps: [],
      },
    ],
  },
};
