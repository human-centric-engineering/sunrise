/**
 * Recipe 9: Autonomous Research Orchestration
 *
 * Patterns: Orchestrator (21) + RAG (14) + Guardrails (18) + Evaluation (19).
 *
 * Flow: retrieve context from the knowledge base → orchestrator step
 * dynamically delegates to available agents based on the planner's
 * assessment of the task → guard the output for quality → evaluate the
 * final report against a rubric.
 *
 * This template showcases the **autonomous multi-agent orchestration**
 * paradigm where an AI planner dynamically decides which agents to
 * involve, how many rounds of delegation to run, and when to stop —
 * in contrast to the fixed DAG paths of the other templates.
 *
 * NOTE: The orchestrator step ships with placeholder agent slugs
 * ('your-agent-1', 'your-agent-2', 'your-agent-3'). After loading
 * this template, open the Orchestrator block's config panel and
 * replace them with your own active agents.
 */

import type { WorkflowTemplate } from '@/prisma/seeds/data/templates/types';

export const AUTONOMOUS_RESEARCH_TEMPLATE: WorkflowTemplate = {
  slug: 'tpl-autonomous-research',
  name: 'Autonomous Research Orchestration',
  shortDescription:
    'An AI planner dynamically coordinates your agents to produce a comprehensive report — adapting strategy based on intermediate results. Replace the placeholder agent slugs with your own.',
  patterns: [
    { number: 7, name: 'Multi-Agent Collaboration' },
    { number: 14, name: 'RAG' },
    { number: 18, name: 'Guardrails' },
    { number: 19, name: 'Evaluation' },
  ],
  flowSummary:
    'A RAG Retrieve step pulls relevant prior knowledge, then an Orchestrator step dynamically delegates tasks to your agents across multiple rounds — the AI planner decides which agents to invoke and adapts its strategy based on intermediate results. A Guard step validates the output for factual grounding and policy compliance, and an Evaluate step scores the final report against a quality rubric. After loading, replace the placeholder agent slugs in the Orchestrator config with your own active agents.',
  useCases: [
    {
      title: 'Market intelligence reports',
      scenario:
        'Retrieve internal market data, let the orchestrator coordinate agents to gather external signals, identify trends, and draft the final report — adapting the investigation depth based on what each round reveals.',
    },
    {
      title: 'Incident post-mortem analysis',
      scenario:
        'Pull logs and prior incident reports from the knowledge base, then let the orchestrator dynamically assign agents to root-cause analysis, timeline reconstruction, and recommendations — re-delegating if the initial analysis raises follow-up questions.',
    },
    {
      title: 'Technology evaluation',
      scenario:
        'Retrieve prior assessments and vendor documentation, then let the orchestrator coordinate agents to evaluate security, performance, and integration fit — with the planner deciding how deep to go in each area based on initial findings.',
    },
  ],
  workflowDefinition: {
    entryStepId: 'retrieve_context',
    errorStrategy: 'retry',
    steps: [
      {
        id: 'retrieve_context',
        name: 'Retrieve prior knowledge',
        type: 'rag_retrieve',
        config: {
          query: '{{input}}',
          topK: 10,
          similarityThreshold: 0.6,
        },
        nextSteps: [{ targetStepId: 'orchestrate' }],
      },
      {
        id: 'orchestrate',
        name: 'Autonomous agent coordination',
        type: 'orchestrator',
        config: {
          plannerPrompt:
            'You are a research coordinator. Your goal is to produce a comprehensive, well-structured report on the given topic.\n\nYou have access to the following context retrieved from our knowledge base:\n{{retrieve_context.output}}\n\nCoordinate the available agents to achieve the best result. Consider what each agent is good at based on their descriptions, and delegate accordingly. Typical phases include:\n1. Gather additional information and fill knowledge gaps\n2. Identify patterns, trends, and insights from the gathered data\n3. Produce a clear, well-structured final report\n\nAdapt your strategy based on what each round reveals. If an agent finds unexpected information, ask another to investigate further. If the analysis reveals gaps, send an agent back for more data. Aim for depth over breadth.',
          availableAgentSlugs: ['your-agent-1', 'your-agent-2', 'your-agent-3'],
          selectionMode: 'auto',
          maxRounds: 4,
          maxDelegationsPerRound: 3,
          timeoutMs: 180000,
          temperature: 0.3,
        },
        nextSteps: [{ targetStepId: 'guard_output' }],
      },
      {
        id: 'guard_output',
        name: 'Validate output quality',
        type: 'guard',
        config: {
          rules:
            'Verify that the report:\n1. Contains specific data points or evidence (not vague generalisations)\n2. Cites sources or knowledge base references where applicable\n3. Does not contain fabricated statistics or unverifiable claims\n4. Maintains a professional, objective tone\n5. Is structured with clear sections and logical flow',
          mode: 'llm',
          failAction: 'retry',
        },
        nextSteps: [{ targetStepId: 'evaluate_report' }],
      },
      {
        id: 'evaluate_report',
        name: 'Score final report',
        type: 'evaluate',
        config: {
          rubric:
            'Score the report on a 1-10 scale across these dimensions:\n- Completeness: Does it address all aspects of the topic?\n- Accuracy: Are claims well-supported by evidence?\n- Clarity: Is the writing clear and well-organised?\n- Actionability: Does it provide useful insights or recommendations?\n- Depth: Does it go beyond surface-level analysis?',
        },
        nextSteps: [],
      },
    ],
  },
};
